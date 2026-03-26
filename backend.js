/*
 * Backend Server for POLSA GRADE
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

        // Validate essential Firebase environment variables
        if (!process.env.FIREBASE_PROJECT_ID) {
            throw new Error("FIREBASE_PROJECT_ID is not set in environment variables.");
        }
        if (!process.env.FIREBASE_CLIENT_EMAIL) {
            throw new Error("FIREBASE_CLIENT_EMAIL is not set in environment variables.");
        }
        if (!privateKey) {
            throw new Error("FIREBASE_PRIVATE_KEY is not set or is empty in environment variables.");
        }
        if (!process.env.FIREBASE_DATABASE_URL) {
            throw new Error("FIREBASE_DATABASE_URL is not set in environment variables.");
        }

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
const VTU_API_KEY = process.env.VTU_API_KEY;
if (!VTU_API_KEY) {
    console.error("CRITICAL ERROR: VTU_API_KEY is not set in environment variables. External API calls will fail. ❌");
    // This won't stop the server from starting, but will make API calls fail.
    // For a critical application, you might consider exiting the process here: process.exit(1);
}
const MASKAWA_BASE_URL = 'https://maskawasub.com/api';
const DALTECH_DATA_API_URL = 'https://daltechsubapi.com.ng/api/data/';
const DALTECH_API_KEY = process.env.DALTECH_API_KEY; 

// Middleware to check Firebase initialization and VTU_API_KEY before processing requests
app.use((req, res, next) => {
    if (!firebaseInitialized) {
        return res.status(500).json({ success: false, message: `Backend service is not fully operational due to Firebase initialization failure. ${firebaseInitError || 'Check server logs for details.'}` });
    }
    if (!VTU_API_KEY || !DALTECH_API_KEY) {
        return res.status(500).json({ success: false, message: "Backend service is not fully operational due to missing API configuration. Contact support." });
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

// --- API Helper ---
async function callApi(url, payload, apiKey) {
    apiKey = apiKey || VTU_API_KEY; // Default to MASKAWA API key
    console.log(`Calling External API: ${url} | Payload: ${JSON.stringify(payload)}`);
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json' // Ensure content type is JSON
            },
            timeout: 60000 // 60s timeout
        });
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

// Check External Service Status
app.get('/api/service-status', async (req, res) => {
    try {
        // Attempt to fetch user details to verify external connectivity
        // Use a generic endpoint to check connectivity, e.g., Maskawa's user endpoint
        await callApi(`${MASKAWA_BASE_URL}/user/`, {}); 
        res.json({ success: true, status: 'operational' });
    } catch (error) {
        console.error('Service Status Check Failed:', error.message);
        res.json({ success: true, status: 'down', error: error.message });
    }
});

// Get Wallet Balance
app.get('/api/wallet/:userId', async (req, res) => {
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
app.post('/api/recharge', async (req, res) => {
    const { userId, service, amount, network, phone_number, plan, planName, quantity, profit } = req.body;

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

    let cost = Number(amount);
    let networkId = getNetworkId(network); // Use let as it might be modified for Daltech

    // Declare refs outside try block to ensure they are accessible in catch for status updates
    let userTxRef, adminTxRef;

    try {
        // No need for `if (!db)` here due to middleware

        // Calculate correct cost for recharge cards (considering quantity and discount)
        if (service === 'recharge-card') { // Existing Recharge Card Logic
            const qty = Math.max(1, parseInt(quantity) || 1); // Ensure positive integer
            const discountSnap = await db.ref('settings/recharge_card/enable_discount').once('value');
            if (discountSnap.val()) {
                cost = Math.max(0, cost - 1);
            }
            cost = cost * qty;
        }

        // 1. Prepare Transaction Data & Log Pending State Immediately
        const safePlan = plan || (service === 'airtime' ? 'Airtime' : 'Standard');
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

        const txData = {
            type: 'purchase',
            feature: service,
            amount: cost,
            profit: Number(profit) || 0,
            status: 'Pending',
            transactionId: requestId,
            date: timestamp,
            timestamp: timestamp, // Required for admin panel sorting/display
            details: details
        };

        // Write 'Pending' state to both User History and Admin Payments
        await userTxRef.set(txData);
        await adminTxRef.set({ ...txData, userId, firebaseTxId, email: 'Processing...' });

        // 2. Validate User & Wallet Balance
        const userRef = db.ref(`users/${userId}`);
        const userSnap = await userRef.once('value');
        const userVal = userSnap.val();

        if (!userVal) throw new Error('User account not found.');

        // Update Admin Log with correct User Details immediately
        const currentBalance = Number(userVal.walletBalance) || 0;
        const userEmail = userVal.email || userVal.fullName || 'Unknown';
        // Fire and forget update to speed up response time slightly
        adminTxRef.update({ email: userEmail, userName: userVal.fullName }).catch(console.error);

        if (currentBalance < cost) {
            throw new Error('Insufficient wallet balance.');
        }

        // 2. Prepare API Payload & Call
        let endpoint = '';
        let payload = {};
        let data = {};

        if (service === 'recharge-card') {
            // --- RECHARGE CARD SPECIFIC FLOW (DALTECHSUB) ---
            
            // A. Validate Balance (No deduction yet)
            const balanceSnap = await userRef.child('walletBalance').once('value');
            const currentBal = Number(balanceSnap.val()) || 0;
            
            if (currentBal < cost) {
                throw new Error('Insufficient wallet balance.');
            }

            // B. Call Daltechsub API
            try {
                const DALTECH_URL = 'https://daltechsubapi.com.ng/api/rechargepin/';
                // DALTECH_API_KEY is already defined globally from process.env
                const ref = `EPIN_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

                // Strict Predefined Mapping (Provider: Daltech)
                // MTN=1, GLO=2, AIRTEL=3, 9MOBILE=4
                const RC_PLAN_MAPPING = {
                    '1': { '100': '1', '200': '2', '500': '3', '1000': '4' },       // MTN
                    '2': { '100': '145', '200': '146', '500': '147', '1000': '148' }, // GLO
                    '3': { '100': '153', '200': '154', '500': '155', '1000': '156' }, // AIRTEL
                    '4': { '100': '149', '200': '150', '500': '151', '1000': '152' }  // 9MOBILE
                };

                const networkPlans = RC_PLAN_MAPPING[String(networkId)];
                if (!networkPlans) {
                    throw new Error(`Network ID ${networkId} is not supported for recharge cards.`);
                }

                // Direct mapping: Amount -> Plan ID
                const planId = networkPlans[String(amount)];

                if (!planId) {
                    throw new Error(`Invalid amount (₦${amount}). Available options: ₦100, ₦200, ₦500, ₦1000`);
                }

                const rcPayload = {
                    network: String(networkId),
                    quantity: String(quantity || 1),
                    plan: planId,
                    businessname: "BILLGRADE", // Use new branding
                    ref: ref
                };

                console.log("DALTECH REQUEST:", rcPayload);
                data = await callApi(DALTECH_URL, rcPayload, DALTECH_API_KEY);
                console.log("DALTECH RESPONSE:", data);

                if (typeof data !== 'object' || data === null) {
                    throw new Error(`Provider returned an invalid, non-JSON response.`);
                }

                const isSuccess = (data.status === 'success' || data.Status === 'successful');
                if (!isSuccess) {
                    const errorMsg = data.msg || data.message || data.error || data.detail || JSON.stringify(data);
                    throw new Error(`Provider Error: ${errorMsg}`);
                }

                let rawPins = data.pin || data.pins;
                if (typeof rawPins === 'string') {
                    data.pins = rawPins.includes(',') ? rawPins.split(',') : [rawPins];
                } else if (Array.isArray(rawPins)) {
                    data.pins = rawPins;
                } else {
                    data.pins = [];
                }

                await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);

            } catch (error) {
                console.error("RC Purchase Failed (No Deduction):", { message: error.message, response: error.response?.data });
                if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) throw new Error("Request timeout. Please try again.");
                if (!error.response) throw new Error("Recharge service temporarily unavailable. Please try again later.");
                throw error;
            }

        } else if (service === 'airtime') { // Existing Airtime Logic
            const endpoint = 'topup/';
            const payload = { network: networkId, amount: cost, mobile_number: phone_number, Ported_number: true, airtime_type: 'VTU' };
            data = await callApi(`${MASKAWA_BASE_URL}/${endpoint}`, payload, VTU_API_KEY);

            const isExplicitFailure = (data.Status && String(data.Status).toLowerCase().includes('fail')) || (data.status && String(data.status).toLowerCase().includes('fail')) || (data.success === 'false') || (data.success === false);
            if (isExplicitFailure) {
                throw new Error(data.message || data.error || 'Provider returned failure status');
            }

            await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);

        } else if (service === 'data') { // NEW DALTECHSUB DATA LOGIC
            const ref = `DATA_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
            const dataPayload = {
                network: String(networkId),
                phone: phone_number,
                ref: ref,
                plan: plan, // This is the plan_id from Daltech
                ported_number: true
            };

            try {
                data = await callApi(DALTECH_DATA_API_URL, dataPayload, DALTECH_API_KEY);
                console.log("Daltech Data Response:", JSON.stringify(data));

                if (typeof data !== 'object' || data === null) {
                    throw new Error(`Provider returned an invalid, non-JSON response.`);
                }

                const isSuccess = (data.status === 'success' || data.Status === 'successful');
                if (!isSuccess) {
                    const errorMsg = data.msg || data.message || data.error || data.detail || JSON.stringify(data);
                    throw new Error(`Provider Error: ${errorMsg}`);
                }

                await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);

            } catch (error) {
                console.error("Data Purchase Failed (No Deduction):", { message: error.message, response: error.response?.data });
                if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) throw new Error("Request timeout. Please try again.");
                if (!error.response) throw new Error("Data service temporarily unavailable. Please try again later.");
                throw error;
            }

        } else {
            return res.status(400).json({ success: false, message: 'Invalid service type' });
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
            message: service === 'recharge-card' ? 'Recharge card generated successfully' : 'Transaction successful',
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

        res.status(500).json({ success: false, message: msg });
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

// Fetch Plans from Daltech (Utility Endpoint for Admin Inspection)
app.get('/api/daltech/plans', async (req, res) => {
    try {
        const DALTECH_KEY = DALTECH_API_KEY;
        // Note: This endpoint assumes Daltech supports GET on the base URL for plans.
        // If they use a specific path like /plans or /prices, update the URL below.
        const response = await axios.get('https://daltechsubapi.com.ng/api/epin-groups/', {
            headers: { 'Authorization': `Token ${DALTECH_KEY}` }
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

// --- 404 Handler for Unknown Routes ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});
