/*
 * Backend Server for BILLGRADE
 * Handles secure API calls to MaskawaSub, Wallet management, and Logging.
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config(); // Ensure dotenv is loaded early

const app = express();
app.use(cors());
app.use(express.json());

// --- Authentication Middleware ---
/**
 * Verifies the Firebase ID Token and ensures the user is authorized.
 * If a userId is present in the path or body, it verifies ownership.
 */
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;

        // Security: Ensure the UID in the token matches the userId in the request (if provided)
        const requestedUserId = req.params.userId || req.body.userId;
        if (requestedUserId && decodedToken.uid !== requestedUserId) {
            return res.status(403).json({ success: false, message: 'Access denied. Identity mismatch.' });
        }
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
    }
};

// --- Environment Variable Validation ---
const REQUIRED_ENV_VARS = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_DATABASE_URL',
    'VTU_API_KEY',
    'DALTECH_API_KEY'
];

REQUIRED_ENV_VARS.forEach(varName => {
    if (!process.env[varName]) {
        console.error(`CRITICAL STARTUP ERROR: Environment variable "${varName}" is missing! ❌`);
        process.exit(1); // Stop the server immediately
    }
});

// --- Root Route ---
app.get('/', (req, res) => {
    res.send('Backend is running!');
});

// --- Firebase Initialization ---
let db; // Firebase Realtime Database instance
let firebaseInitialized = false; // Flag to track successful Firebase initialization
let firebaseInitError = null; // Stores any error message from Firebase init

try {
    // Initialize Firebase Admin SDK
    if (!admin.apps.length) {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY 
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').trim() 
            : undefined;

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey
            }),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
    }
    db = admin.database();
    firebaseInitialized = true;
    console.log("Firebase Admin SDK Initialized ✅");

    // Test Database Connection
    // This writes a timestamp to a specific path to confirm connectivity
    db.ref('backend_status/last_connected').set(admin.database.ServerValue.TIMESTAMP)
        .then(() => {
            console.log("Firebase Realtime Database connection test successful ✅");
        })
        .catch(err => {
            console.error("Firebase Realtime Database connection test failed: ❌", err.message);
            firebaseInitError = `Firebase DB connection failed: ${err.message}`;
            firebaseInitialized = false; // Mark as failed if DB connection fails
        });

} catch (error) {
    console.error("Firebase Initialization Failed: ❌", error.message);
    firebaseInitError = `Firebase initialization failed: ${error.message}`;
    firebaseInitialized = false;
}

// Validate VTU API Key
const VTU_API_KEY = process.env.VTU_API_KEY; // Now guaranteed by validation above
const MASKAWA_BASE_URL = 'https://maskawasub.com/api';
const DALTECH_DATA_API_URL = 'https://daltechsubapi.com.ng/api/data/';
const DALTECH_API_KEY = process.env.DALTECH_API_KEY;

// Middleware to check Firebase initialization and VTU_API_KEY before processing requests
app.use((req, res, next) => {
    if (!firebaseInitialized) {
        return res.status(500).json({ success: false, message: `Backend service is not fully operational due to Firebase initialization failure. ${firebaseInitError || 'Check server logs for details.'}` });
    }
    next();
});

// --- Helper Functions ---

const getNetworkId = (networkStr) => {
    // Map network names/IDs to Maskawa standard IDs
    const map = {
        'mtn': 1, '1': 1,
        'glo': 2, '2': 2,
        'airtel': 3, '3': 3,
        '9mobile': 4, '4': 4
    };
    return map[String(networkStr).toLowerCase()] || networkStr;
};

const getNetworkKey = (networkId) => {
    const map = {
        1: 'mtn', 2: 'glo', 3: 'airtel', 4: '9mobile'
    };
    return map[Number(networkId)];
};

// --- API Helper ---
async function callApi(url, payload, apiKey, method = 'POST') {
    const isDaltech = url.includes('daltechsubapi');
    const authHeader = isDaltech ? `Token ${apiKey}` : `Token ${apiKey || VTU_API_KEY}`;
    
    console.log(`Calling External API (${method}): ${url} | Payload: ${JSON.stringify(payload)}`);
    try {
        const config = {
            method: method,
            url: url,
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 60000
        };

        if (method === 'POST') {
            config.data = payload;
        } else {
            // For GET requests, only add params if they aren't empty to avoid trailing '?'
            if (payload && Object.keys(payload).length > 0) {
                config.params = payload;
            }
            delete config.headers['Content-Type']; // Some servers reject GETs with this header
        }

        const response = await axios(config);
        return response.data;
    } catch (error) {
        // Log detailed error for debugging
        console.error(`API Request Failed [${url}]:`, JSON.stringify({
            message: error.message,
            code: error.code,
            status: error.response?.status,
            responseData: error.response?.data,
            payload: payload
        }, null, 2));

        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            throw new Error("Request timeout. Please try again.");
        }
        if (!error.response) {
            throw new Error("Recharge service temporarily unavailable. Please try again later.");
        }

        let detailedMsg = error.message;
        if (error.response && error.response.data) {
            const data = error.response.data;
            // Check for common error fields from Django/DRF APIs (detail, message, error, or object keys)
            detailedMsg = data.detail || data.message || data.error || (typeof data === 'object' ? JSON.stringify(data) : data);
        }
        error.message = `Provider Error: ${detailedMsg}`;
        throw error;
    }
}

// --- Endpoints ---

// Exchange Rate Helper (Global)
app.get('/api/exchange-rate', async (req, res) => {
    try {
        const rate = await require('./js/exchangerateservice').getRate();
        res.json({ success: true, rate });
    } catch (e) { res.status(500).json({ rate: 1600 }); }
});

// Check External Service Status
app.get('/api/service-status', async (req, res) => {
    try {
        // Attempt to fetch user details to verify external connectivity
        // Use a generic endpoint to check connectivity, e.g., Maskawa's user endpoint
        await callApi(`${MASKAWA_BASE_URL}/user/`, {}, VTU_API_KEY, 'GET'); 
        res.json({ success: true, status: 'operational' });
    } catch (error) {
        console.error('Service Status Check Failed:', error.message);
        res.json({ success: true, status: 'down', error: error.message });
    }
});

// --- Filtered Data Plans API (Requirement 6) ---
app.get('/api/plans/filtered', async (req, res) => {
    const { network } = req.query;
    if (!network) return res.status(400).json({ success: false, message: 'Network is required' });

    try {
        const networkKey = network.toLowerCase();
        // Pointing to services/data_plans where actual operational data is stored
        const snapshot = await db.ref(`services/data_plans/${networkKey}`).once('value');
        const dbPlans = snapshot.val() || {};

        const plansByCat = {};
        const categories = new Set();

        Object.entries(dbPlans).forEach(([id, p]) => {
            if (!p || p.status === false) return;
            
            // Extract categories (SME 1, SME 2, Gifting, etc.)
            let cat = p.plan_category || p.category || 'Other';
            const catLower = cat.toLowerCase();
            if (['all', 'number seven', 'none', 'deprecated'].includes(catLower)) return;

            // Group plans by category
            if (!plansByCat[p.plan_category || cat]) plansByCat[p.plan_category || cat] = [];
            plansByCat[p.plan_category || cat].push({
                id: id,
                plan_name: p.plan_name || p.name,
                api_cost: p.api_cost || 0,
                selling_price: p.selling_price || p.price || 0,
                validity: p.validity
            });
        });

        const sortedCategories = Object.keys(plansByCat).sort();
        res.json({
            network: network.toUpperCase(),
            categories: sortedCategories,
            plans: plansByCat
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Wallet Balance
app.get('/api/wallet/:userId', authenticate, async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    try {
        // No need for `if (!db)` here due to middleware
        const snapshot = await db.ref(`users/${userId}/walletBalance`).once('value');
        const balance = Number(snapshot.val()) || 0;
        res.json({ success: true, balance });
    } catch (error) {
        console.error('Wallet Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch wallet balance' });
    }
});

// Matches /api/recharge used in frontend Bills.js
app.post('/api/recharge', authenticate, async (req, res) => {
    let { userId, service, amount, network, phone_number, plan, planName, quantity, profit } = req.body;

    if (!VTU_API_KEY || !DALTECH_API_KEY) {
        return res.status(500).json({ success: false, message: "Server API configuration is missing for recharge services." });
    }

    // Generate a local request ID for tracing logs
    const requestId = `req_${Date.now()}`;

    // Enhanced validation for mandatory fields
    if (!userId || !service || !amount) {
        return res.status(400).json({ success: false, message: 'Missing required fields: userId, service, and amount are mandatory.' });
    }

    // Service-specific field validation
    if (service === 'data' && (!plan || !network || !phone_number)) {
        return res.status(400).json({ success: false, message: 'For Data purchases, you must provide a plan, network, and phone number.' });
    }
    if (service === 'airtime' && (!network || !phone_number || phone_number.length < 10)) {
        return res.status(400).json({ success: false, message: 'For Airtime purchases, you must provide a valid network and phone number.' });
    }

    // Declare refs outside try block for catch accessibility
    let userTxRef, adminTxRef;
    let cost = Number(amount);
    let calculatedProfit = Number(profit) || 0;
    let planData = null;
    let networkId = getNetworkId(network); // Use let as it might be modified for Daltech

    try {
        // 1. Fetch User Data & Role for Valuation
        const userRef = db.ref(`users/${userId}`);
        const userSnap = await userRef.once('value');
        const userVal = userSnap.val();
        if (!userVal) throw new Error('User account not found.');

        const userRole = (userVal.role || 'Subscriber').toLowerCase();

        // 2. Perform Server-Side Valuation based on Plan ID and User Role
        if (service === 'data') {
            // 'plan' from frontend is now the Firebase key (e.g., 'plan_6')
            const planFirebaseKey = plan;
            const networkKey = getNetworkKey(networkId);
            
            const planSnap = await db.ref(`services/data_plans/${networkKey}/${planFirebaseKey}`).once('value');
            planData = planSnap.val();
            
            if (!planData) {
                throw new Error(`Data plan with ID ${planFirebaseKey} not found for network ${networkKey}.`);
            }

            // Use the selling price from Firebase for user deduction
            cost = planData.selling_price || planData.price;
            // Calculate profit based on selling price and API cost
            calculatedProfit = Math.max(0, cost - (planData.api_cost || planData.apiCost || 0));

            // Update plan variable to be the actual API plan ID for Daltech call
            plan = planData.apiPlanId;

            console.log(`Valuation [${userRole}]: Plan ${planData.plan_name || planData.name}, Selling Price: ₦${cost}, Profit: ₦${calculatedProfit}`);
            
            // Also update planName for logging
            planName = planData.plan_name || planData.name;

            // Check if the plan is active
            if (planData.status === false) {
                throw new Error(`Data plan ${planData.name} is currently unavailable.`);
            }
        }

        // Calculate correct cost for recharge cards (considering quantity and discount)
        if (service === 'recharge-card') { // Existing Recharge Card Logic
            const qty = Math.max(1, parseInt(quantity) || 1); // Ensure positive integer
            const discountSnap = await db.ref('settings/recharge_card/enable_discount').once('value');
            if (discountSnap.val()) {
                cost = Math.max(0, cost - 1);
            }
            cost = cost * qty;
        }

        // 3. Prepare Transaction Data & Log Pending State
        const safePlan = planName || plan || (service === 'airtime' ? 'Airtime' : 'Standard');
        const details = {
            network: network || 'N/A',
            phone: phone_number || 'N/A',
            plan: safePlan,
            ...(planName && { planName }), 
            ...(quantity && { quantity })  
        };

        userTxRef = db.ref(`transactions/${userId}`).push();
        adminTxRef = db.ref('payments').push();
        const firebaseTxId = userTxRef.key;
        const timestamp = new Date().toISOString();

        // Exact amount check for logging
        let txData = {
            type: 'purchase',
            feature: service,
            amount: cost,
            profit: calculatedProfit,
            status: 'Processing',
            transactionId: requestId,
            date: timestamp,
            timestamp: timestamp, // Required for admin panel sorting/display
            details: details
        }; 
        // Add plan details to txData for data purchases
        if (service === 'data' && planData) txData.details = { ...txData.details, ...planData };

        // Record initial processing state
        await userTxRef.set(txData);
        await adminTxRef.set({ ...txData, userId, firebaseTxId, email: 'Processing...' });

        // --- ATOMIC DEBIT (The "Debit-First" Fix) ---
        // We debit the wallet using a transaction BEFORE calling the external API.
        // This prevents double-spending.
        const debitResult = await userRef.child('walletBalance').transaction((currentBalance) => {
            if (currentBalance === null) return 0;
            const bal = Number(currentBalance);
            if (bal < cost) return; // Abort transaction if insufficient funds
            return bal - cost;
        });

        if (!debitResult.committed) {
            throw new Error('Insufficient wallet balance.');
        }

        let data = {};
        try {
            if (service === 'recharge-card') {
                const DALTECH_URL = 'https://daltechsubapi.com.ng/api/rechargepin/';
                const ref = `EPIN_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
                const RC_PLAN_MAPPING = {
                    '1': { '100': '1', '200': '2', '500': '3', '1000': '4' },       // MTN
                    '2': { '100': '145', '200': '146', '500': '147', '1000': '148' }, // GLO
                    '3': { '100': '153', '200': '154', '500': '155', '1000': '156' }, // AIRTEL
                    '4': { '100': '149', '200': '150', '500': '151', '1000': '152' }  // 9MOBILE
                };
                const networkPlans = RC_PLAN_MAPPING[String(networkId)];
                if (!networkPlans) throw new Error(`Network not supported for recharge cards.`);
                
                const planId = networkPlans[String(amount)];
                if (!planId) throw new Error(`Invalid amount (₦${amount}).`);

                const rcPayload = {
                    network: String(networkId),
                    quantity: String(quantity || 1),
                    plan: planId,
                    businessname: "BILLGRADE",
                    ref: ref
                };
                data = await callApi(DALTECH_URL, rcPayload, DALTECH_API_KEY);
                
                const isSuccess = (data.status === 'success' || data.Status === 'successful');
                if (!isSuccess) throw new Error(data.msg || data.message || "Provider Error");
                
                let rawPins = data.pin || data.pins;
                data.pins = typeof rawPins === 'string' ? (rawPins.includes(',') ? rawPins.split(',') : [rawPins]) : (Array.isArray(rawPins) ? rawPins : []);

            } else if (service === 'airtime') {
                const payload = { network: networkId, amount: amount, mobile_number: phone_number, Ported_number: true, airtime_type: 'VTU' };
                data = await callApi(`${MASKAWA_BASE_URL}/topup/`, payload, VTU_API_KEY);
                const isSuccess = (data.status === 'success' || data.Status === 'successful' || data.success === true);
                if (!isSuccess) throw new Error(data.msg || data.message || "Airtime purchase failed");

            } else if (service === 'data') {
                const dataPayload = {
                    network: Number(networkId),
                    phone: phone_number,
                    ref: `BILLGRADE_DATA_${Date.now()}`,
                    plan: Number(planData.apiPlanId),
                    ported_number: true
                };
                data = await callApi(DALTECH_DATA_API_URL, dataPayload, DALTECH_API_KEY);
                const isSuccess = (data.status === 'success' || data.Status === 'successful');
                if (!isSuccess) throw new Error(data.msg || data.message || "Data purchase failed");
            }
        } catch (apiError) {
            // --- REFUND LOGIC ---
            // If the provider API fails, we refund the EXACT amount debited.
            await userRef.child('walletBalance').transaction((currentBalance) => {
                if (currentBalance === null) return currentBalance;
                return Number(currentBalance) + cost;
            });
            throw apiError;
        }

            const isExplicitFailure = (data.Status && String(data.Status).toLowerCase().includes('fail')) || (data.status && String(data.status).toLowerCase().includes('fail')) || (data.success === 'false') || (data.success === false);

        if (isExplicitFailure) {
            throw new Error(data.msg || data.message || "Provider reported failure");
        }

        // Common success handling for all services after deduction
        // 6. Update to Successful & Record Provider Response
        const successUpdate = { 
            status: 'Successful',
            providerResponse: data
        };
        await userTxRef.update(successUpdate);
        await adminTxRef.update(successUpdate);

        // 7. Return Success
        const pins = data.pins || (data.pin ? [data.pin] : (data.token ? [data.token] : []));
        
        const response = {
            success: true,
            message: service === 'data' ? 'Data purchase successful' : (service === 'recharge-card' ? 'Recharge card generated successfully' : 'Transaction successful'),
            data: {
                ...data,
                receipt: {
                    ...txData,
                    transactionId: firebaseTxId
                }
            }
        };

        if (service === 'recharge-card') {
            const primaryPin = pins.length > 0 ? (pins[0].pin || pins[0]) : "Check Transaction History";
            response.pin = primaryPin;
            response.network = network;
            response.amount = cost;
        }

        res.json(response);

    } catch (error) {
        // Extract detailed error message from provider response
        const errData = error.response?.data || {};
        const msg = (typeof errData === 'string' ? errData : (errData.message || errData.msg || errData.error || errData.detail)) || error.message || 'Transaction failed';
        
        console.error('Recharge Endpoint Error:', {
            requestId: requestId,
            errorMessage: error.message,
            providerResponse: errData,
            stack: error.stack
        });
        
        // Update logs to Failed
        if (userTxRef && adminTxRef) {
            const failUpdate = { 
                status: 'Failed', 
                reason: msg,
                providerResponse: errData || null
            };
            userTxRef.update(failUpdate).catch(console.error);
            adminTxRef.update(failUpdate).catch(console.error);
        }

        // Show the generic "Transaction failed" message unless it's the specific "invalid plan" error
        let finalMsg = "Transaction failed. Please try again later.";
        if (msg.includes("Selected data plan is no longer available")) finalMsg = msg;

        res.status(500).json({ success: false, message: finalMsg });
    }
});

// Get Transaction History
app.get('/api/transactions/:userId', async (req, res) => {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    if (!userId) return res.status(400).json({ success: false, message: 'Missing userId' });

    try {
        // No need for `if (!db)` here due to middleware

        const snapshot = await db.ref(`transactions/${userId}`).limitToLast(limit).once('value');
        const transactions = [];
        
        // snapshot.forEach iterates in key order (oldest to newest for push IDs)
        // We unshift to reverse array so newest is first
        snapshot.forEach(child => {
            transactions.unshift({ id: child.key, ...child.val() });
        });

        res.json({ success: true, transactions });
    } catch (error) {
        console.error('History Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch history' });
    }
});

// Update Recharge Card Discount Setting
app.post('/api/settings/recharge-discount', async (req, res) => {
    const { enabled } = req.body;

    if (enabled === undefined || typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Invalid payload: "enabled" (boolean) is required.' });
    }

    try {
        // No need for `if (!db)` here due to middleware
        
        await db.ref('settings/recharge_card/enable_discount').set(enabled);
        
        res.json({ success: true, message: `Recharge card discount ${enabled ? 'enabled' : 'disabled'} successfully.` });
    } catch (error) {
        console.error('Settings Update Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to update settings.' });
    }
});

// --- Dynamic Plan Management ---

// New endpoint to fetch data plans from Daltech
app.get('/api/daltech/data-plans/:networkId', async (req, res) => {
    const { networkId } = req.params;
    if (!networkId) {
        return res.status(400).json({ success: false, message: 'Network ID is required.' });
    }

    try {
        const DALTECH_DATA_PLANS_URL = 'https://daltechsubapi.com.ng/api/data/'; // Assuming this endpoint lists plans
        const response = await axios.get(DALTECH_DATA_PLANS_URL, {
            headers: { 'Authorization': `Token ${DALTECH_API_KEY}` },
            params: { network: networkId } // Filter by network if API supports it
        });
        
        const daltechPlans = response.data.data; // Assuming plans are in a 'data' field
        if (!Array.isArray(daltechPlans)) {
            throw new Error("Invalid data plans format received from provider.");
        }

        // Filter and normalize plans to include only relevant fields and vendor price
        const plans = daltechPlans.map(p => ({
            plan_id: p.plan_id,
            name: p.plan_name, // Assuming plan_name is the descriptive name
            validity: p.validity,
            price: p.price, // This is the vendor price
            category: p.plan_type || 'General' // Assuming plan_type can be used for category
        }));

        res.json({ success: true, plans: plans });
    } catch (error) {
        console.error('Daltech Data Plans Fetch Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch data plans from provider', 
            error: error.message,
            providerResponse: error.response?.data 
        });
    }
});

// Existing endpoint to fetch RC plans from Daltech (Utility Endpoint for Admin Inspection)
app.get('/api/daltech/plans', async (req, res) => {
    try {
        const DALTECH_RC_KEY = DALTECH_API_KEY; // Use the environment variable for consistency
        const response = await axios.get('https://daltechsubapi.com.ng/api/epin-groups/', {
            headers: { 'Authorization': `Token ${DALTECH_RC_KEY}` }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error('Daltech Fetch Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch plans from provider', 
            error: error.message,
            providerResponse: error.response?.data 
        });
    }
});

// Save Plan Mapping to Firebase
app.post('/api/settings/rc-plans', async (req, res) => {
    // Expected payload: { "1": { "100": "5", "200": "6" }, "2": { ... } }
    const mappings = req.body;
    if (!mappings || typeof mappings !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid mapping data' });
    }
    try {
        await db.ref('settings/recharge_card/plans').set(mappings);
        res.json({ success: true, message: 'Recharge card plan mappings updated successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Save Data Plan Mapping/Pricing to Firebase
app.post('/api/settings/data-plans', async (req, res) => {
    // Expected structure for the plan list provided:
    // { "mtn": { "plan_6": { id: 6, name: "500MB", ... } }, ... }
    const mappings = req.body;
    if (!mappings || typeof mappings !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid mapping data' });
    }
    try {
        await db.ref('settings/data_plans').set(mappings);
        res.json({ success: true, message: 'Data plan mappings and pricing updated successfully.' });
    } catch (error) {
        console.error('Data Plans Update Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to update data plans.' });
    }
});

// Get saved Data Plan settings
app.get('/api/settings/data-plans', async (req, res) => {
    try {
        const snapshot = await db.ref('settings/data_plans').once('value');
        res.json({ success: true, plans: snapshot.val() || {} });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Save Plan ID Ranges (Gifting/Corporate) to Firebase
app.post('/api/settings/plan-ranges', async (req, res) => {
    const { gifting, corporate } = req.body;
    // Expected format: { gifting: [[start, end], ...], corporate: [[start, end], ...] }
    if (!gifting && !corporate) {
        return res.status(400).json({ success: false, message: 'Invalid range data provided.' });
    }
    try {
        await db.ref('settings/plan_ranges').set({ gifting: gifting || [], corporate: corporate || [] });
        res.json({ success: true, message: 'Plan ID ranges updated successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get current Plan ID Ranges
app.get('/api/settings/plan-ranges', async (req, res) => {
    try {
        const snapshot = await db.ref('settings/plan_ranges').once('value');
        res.json({ success: true, ranges: snapshot.val() || { gifting: [], corporate: [] } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- Admin Overview Endpoints ---
// Get Maskawa Wallet Balance
app.get('/api/balance/maskawa', async (req, res) => {
    try {
        const data = await callApi(`${MASKAWA_BASE_URL}/user/`, {}, VTU_API_KEY, 'GET');
        const balance = data.user?.wallet_balance || data.wallet_balance || 0;
        res.json({ success: true, balance: Number(balance) });
    } catch (error) {
        console.error('Maskawa Balance Fetch Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- Specific Admin Balance Endpoints ---
app.get('/api/admin/balance/daltech', async (req, res) => {
    try {
        const data = await callApi('https://daltechsubapi.com.ng/api/user/', {}, DALTECH_API_KEY, 'GET');
        res.json({ balance: Number(data.user?.wallet_balance || data.wallet_balance || 0) });
    } catch (error) {
        console.error('Daltech Balance Error:', error.message);
        res.status(500).json({ balance: 0, error: error.message });
    }
});

app.get('/api/admin/balance/maskawa', async (req, res) => {
    try {
        const data = await callApi(`${MASKAWA_BASE_URL}/user/`, {}, VTU_API_KEY, 'GET');
        res.json({ balance: Number(data.user?.wallet_balance || data.wallet_balance || 0) });
    } catch (error) {
        console.error('Maskawa Balance Error:', error.message);
        res.status(500).json({ balance: 0, error: error.message });
    }
});

// Get Daltech Wallet Balance
app.get('/api/balance/daltech', async (req, res) => {
    try {
        const data = await callApi('https://daltechsubapi.com.ng/api/user/', {}, DALTECH_API_KEY, 'GET');
        const balance = data.user?.wallet_balance || data.wallet_balance || 0;
        res.json({ success: true, balance: Number(balance) });
    } catch (error) {
        console.error('Daltech Balance Fetch Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Provider Wallet Balances (Combined for frontend efficiency)
app.get('/api/admin/provider-balances', async (req, res) => {
    try {
        const [maskawaRes, daltechRes] = await Promise.allSettled([
            callApi(`${MASKAWA_BASE_URL}/user/`, {}, VTU_API_KEY, 'GET'),
            callApi('https://daltechsubapi.com.ng/api/user/', {}, DALTECH_API_KEY, 'GET')
        ]);

        const getBal = (res) => {
            if (res.status === 'rejected') return 'Error';
            const data = res.value || {};
            const balance = data.user?.wallet_balance || data.wallet_balance;
            // Return 'Error' if the response body itself indicates a provider failure
            if (balance === undefined && (data.status === 'fail' || data.Status === 'failed')) return 'Error';
            return balance || 0;
        };

        res.json({
            success: true,
            balances: {
                maskawa: getBal(maskawaRes),
                daltech: getBal(daltechRes)
            }
        });
    } catch (error) {
        console.error('Provider Balances Fetch Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- 404 Handler for Unknown Routes ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});
