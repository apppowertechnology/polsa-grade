/*
 * Backend Server for POLSA GRADE
 * Handles secure API calls to MaskawaSub, Wallet management, and Logging.
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Root Route ---
app.get('/', (req, res) => {
    res.send('Backend is running!');
});

// --- Firebase Initialization ---
let db;
let initError = null;

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
    console.log("Firebase Initialized ✅");

    // Test Database Connection
    db.ref('test_connection').set({ connected: true, timestamp: Date.now() })
        .then(snapshot => {
            console.log("Database connection test successful ✅");
        })
        .catch(err => {
            console.error("Database connection test failed:", err.message);
        });

} catch (error) {
    console.error("Firebase Initialization Failed:", error.message);
    initError = error.message;
}

const VTU_API_KEY = process.env.VTU_API_KEY;
const MASKAWA_BASE_URL = 'https://maskawasub.com/api';

// --- Network Prefix Mapping for Validation ---
const NETWORK_PREFIXES = {
    '1': ['0803', '0806', '0703', '0903', '0906', '0810', '0813', '0814', '0816', '0706', '0913', '0916', '07025', '07026', '0704'], // MTN
    '2': ['0805', '0807', '0705', '0815', '0811', '0905', '0915'], // GLO
    '3': ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'], // Airtel
    '4': ['0809', '0818', '0817', '0909', '0908'] // 9mobile
};

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

const validateNetworkPrefix = (phone, networkId) => {
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('234')) cleanPhone = '0' + cleanPhone.substring(3);
    const prefixes = NETWORK_PREFIXES[String(networkId)];
    if (!prefixes) return true; // Skip if network mapping unknown
    return prefixes.some(p => cleanPhone.startsWith(p));
};

// --- Valid Data Plan Source of Truth ---
const VALID_DATA_PLANS = {
    '1': ['6', '7', '8', '9', '10', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '39', '40', '41', '42', '43', '44', '45', '46', '47', '129', '130', '131', '132', '133', '134', '135', '136', '137', '139', '164', '165', '166'], // MTN
    '2': ['96', '97', '98', '99', '100', '101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114', '115', '116', '117', '118', '119', '120', '121', '122', '140', '141', '142', '143', '144', '148', '149', '150', '151', '152', '153', '154', '155', '156'], // GLO
    '3': ['48', '50', '51', '52', '53', '54', '56', '58', '59', '60', '61', '62', '63', '64', '65', '66', '67', '68', '69', '70', '71', '72', '73', '74', '75', '76', '78', '79', '80', '81', '82', '83', '84', '85', '86', '87', '88', '89', '90', '91', '92', '93', '94', '95', '138', '146', '160', '161', '162', '163'], // Airtel
    '4': ['123', '124', '125', '126', '127', '128'] // 9mobile
};

/**
 * Pushes a notification to the admin dashboard.
 */
const sendAdminAlert = async (title, message, details = {}) => {
    if (!db) return;
    try {
        await db.ref('admin_alerts').push({
            title,
            message,
            details,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            isRead: false
        });
    } catch (err) {
        console.error("Admin Alert failed:", err.message);
    }
};

// --- API Helper ---
async function callApi(endpoint, payload) {
    const url = `${MASKAWA_BASE_URL}/${endpoint}`;
    console.log(`Calling VTU API: ${url} | Payload: ${JSON.stringify(payload)}`);
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Token ${VTU_API_KEY}`,
                'Content-Type': 'application/json'
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
        // We use 'user/' endpoint which typically returns profile info for Maskawa/Husmodata scripts
        await callApi('user/', {}); 
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
        if (!db) throw new Error('Backend not connected to Firebase');
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

    const networkId = getNetworkId(network);
    const qty = Math.max(1, parseInt(quantity) || 1);
    let pinCharge = 0;
    let backendProfit = Number(profit) || 0;
    let cost = Number(amount);

    // Enhanced validation for mandatory fields
    if (!userId || !service || !amount || !network || !phone_number) {
        return res.status(400).json({ success: false, message: 'Missing required fields: userId, service, amount, network, and phone_number are mandatory.' });
    }

    // --- Charge Calculation (Backend Enforced) ---
    if (service === 'recharge-card') {
        const discountSnap = await db.ref('settings/recharge_card/enable_discount').once('value');
        const isDiscountEnabled = !!discountSnap.val();
        
        // Re-calculate cost from base unit price
        let unitPrice = Number(amount);
        if (isDiscountEnabled) {
            unitPrice = Math.max(0, unitPrice - 1);
        }
        
        const baseCost = unitPrice * qty;
        // Apply ₦5 charge for each additional PIN (above 1)
        pinCharge = (qty > 1) ? (qty - 1) * 5 : 0;
        cost = baseCost + pinCharge;

        // Securely re-calculate profit (Provider discount ₦2, User discount ₦1 or ₦0)
        const providerDiscount = 2;
        const userDiscount = isDiscountEnabled ? 1 : 0;
        backendProfit = ((providerDiscount - userDiscount) * qty) + pinCharge;
    }

    // Strict Network Validation
    if (!validateNetworkPrefix(phone_number, networkId)) {
        const netName = { '1': 'MTN', '2': 'GLO', '3': 'Airtel', '4': '9mobile' }[String(networkId)] || 'selected';
        return res.status(400).json({ success: false, message: `Please enter a valid ${netName} number` });
    }

    // Service-specific field validation
    if (service === 'data' && !plan) {
        return res.status(400).json({ success: false, message: 'For Data purchases, a plan ID is required.' });
    }
    if (service === 'airtime' && phone_number.length < 10) {
        return res.status(400).json({ success: false, message: 'Invalid phone number length for airtime purchase.' });
    }

    // --- Strict Data Plan ID Validation ---
    if (service === 'data') {
        const cleanPlanId = String(plan).replace('plan_', '');
        const validPlansForNetwork = VALID_DATA_PLANS[String(networkId)];
        
        if (!validPlansForNetwork || !validPlansForNetwork.includes(cleanPlanId)) {
            await sendAdminAlert('Security: Invalid Plan Attempt', `User ${userId} attempted to buy plan ID: ${plan} on network ${networkId}. Transaction blocked locally.`, { userId, plan, networkId, phone_number });
            return res.status(400).json({ success: false, message: 'Invalid plan selected. Please choose a valid data plan.' });
        }
    }

    // Declare refs outside try block to ensure they are accessible in catch for status updates
    let userTxRef, adminTxRef;

    try {
        if (!db) {
            throw new Error(`Backend not connected to Firebase: ${initError || 'Check server logs.'}`);
        }

        // Calculate correct cost for recharge cards (considering quantity and discount)
        if (service === 'recharge-card') {
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
            amount: cost, // Deducted from wallet
            originalAmount: Number(amount) * qty,
            charge: pinCharge,
            profit: backendProfit,
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
                const DALTECH_KEY = 'HACC3C3vBis67qwC2tEA0CFbn82l3d7A24exB9z3BJxpoC8acrxc4mkA5AI91774270916';
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
                    plan: planId, // Send the mapped Plan ID (e.g., '5') instead of '100'
                    businessname: "Prime Biller",
                    ref: ref
                };

                console.log(`Calling Daltech RC: ${JSON.stringify(rcPayload)}`);
                const response = await axios.post(DALTECH_URL, rcPayload, {
                    headers: {
                        'Authorization': `Token ${DALTECH_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000 // 60s timeout
                });

                data = response.data;
                console.log("Daltech Response:", JSON.stringify(data));
                
                if (typeof data !== 'object' || data === null) {
                    throw new Error(`Provider returned an invalid, non-JSON response.`);
                }

                // Validate Success
                // Daltech success is typically "success" or "successful" in status
                const isSuccess = (data.status === 'success' || data.Status === 'successful');
                
                if (!isSuccess) {
                    // Capture all possible error fields
                    const errorMsg = data.msg || data.message || data.error || data.detail || JSON.stringify(data);
                    throw new Error(`Provider Error: ${errorMsg}`);
                }

                // Normalize PINs to array
                // Daltech returns "1234, 5678" string
                let rawPins = data.pin || data.pins;
                if (typeof rawPins === 'string') {
                    data.pins = rawPins.includes(',') ? rawPins.split(',') : [rawPins];
                } else if (Array.isArray(rawPins)) {
                    data.pins = rawPins;
                } else {
                    data.pins = []; // Fallback
                }

                // C. Finalize Deduction on Success
                await userRef.child('walletBalance').transaction(current => {
                    return (Number(current) || 0) - cost;
                });

            } catch (error) {
                // No refund needed since we didn't deduct yet
                console.error("RC Purchase Failed (No Deduction):", {
                    message: error.message,
                    response: error.response?.data
                });
                
                if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                    throw new Error("Request timeout. Please try again.");
                }
                if (!error.response) {
                    throw new Error("Recharge service temporarily unavailable. Please try again later.");
                }
                
                throw error;
            }

        } else if (service === 'data') {
            // --- DATA-SPECIFIC FLOW (DALTECHSUB) ---
            try {
                const DALTECH_DATA_URL = 'https://daltechsubapi.com.ng/api/data/';
                const DALTECH_KEY = 'HACC3C3vBis67qwC2tEA0CFbn82l3d7A24exB9z3BJxpoC8acrxc4mkA5AI91774270916';

                const dataPayload = {
                    network: String(networkId),
                    phone: phone_number,
                    plan: String(plan).replace('plan_', ''), // Sanitize plan ID for the provider
                    ref: requestId,
                    ported_number: true
                };

                console.log(`Calling Daltech Data: ${JSON.stringify(dataPayload)}`);
                const response = await axios.post(DALTECH_DATA_URL, dataPayload, {
                    headers: {
                        'Authorization': `Token ${DALTECH_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                });

                data = response.data;
                console.log("Daltech Data Response:", JSON.stringify(data));

                if (typeof data !== 'object' || data === null) {
                    throw new Error(`Provider returned an invalid, non-JSON response.`);
                }

                const isSuccess = (data.status === 'success' || data.Status === 'successful');
                if (!isSuccess) {
                    const errorMsg = data.msg || data.message || data.error || data.detail || JSON.stringify(data);
                    throw new Error(`Provider Error: ${errorMsg}`);
                }
            
            if (!dataPayload.plan) {
                 throw new Error(`Invalid plan ID: ${plan}. Please contact support.`);
            }

                // Deduct Balance on Success
                await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);
            } catch (error) {
                console.error("Data Purchase Failed (No Deduction):", { message: error.message, response: error.response?.data });
                if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) { throw new Error("Request timeout. Please try again."); }
                throw error;
            }

        } else {
            // --- STANDARD FLOW (Airtime/Data) ---
            if (service === 'airtime') {
                endpoint = 'topup/';
                payload = { network: networkId, amount: cost, mobile_number: phone_number, Ported_number: true, airtime_type: 'VTU' };
            } else {
                return res.status(400).json({ success: false, message: 'Invalid service type' });
            }

            // Call Maskawa API
            data = await callApi(endpoint, payload);

            // Check Success
            const isExplicitFailure = (data.Status && String(data.Status).toLowerCase().includes('fail')) || (data.status && String(data.status).toLowerCase().includes('fail')) || (data.success === 'false') || (data.success === false);
            if (isExplicitFailure) {
                throw new Error(data.message || data.error || 'Provider returned failure status');
            }

            // Deduct Balance (Standard Flow)
            await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);
        }

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

        // Notify Admin of Provider Rejection
        if (msg.toLowerCase().includes('invalid plan') || msg.toLowerCase().includes('plan_id')) {
            await sendAdminAlert('Provider Rejected Plan ID', `DaltechSub rejected plan ID ${plan}. Response: ${msg}`, { plan, userId, networkId, errData });
        }
        
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
        if (!db) throw new Error('Backend not connected to Firebase');

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
        if (!db) throw new Error('Backend not connected to Firebase');
        
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
        const DALTECH_KEY = 'HACC3C3vBis67qwC2tEA0CFbn82l3d7A24exB9z3BJxpoC8acrxc4mkA5AI91774270916';
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

// --- Automated Data Plan Sync ---

const calculateSellingPrice = (apiCost) => {
    if (apiCost < 200) return apiCost + 35;
    if (apiCost < 500) return apiCost + 80;
    if (apiCost < 1000) return apiCost + 100;
    if (apiCost < 2000) return apiCost + 150;
    if (apiCost < 3000) return apiCost + 200;
    if (apiCost < 5000) return apiCost + 250;
    if (apiCost < 10000) return apiCost + 300;
    return apiCost + 500;
};

async function runDataPlanSync() {
    console.log("[Schedule] Starting automated data plan sync...");
    const DALTECH_KEY = 'HACC3C3vBis67qwC2tEA0CFbn82l3d7A24exB9z3BJxpoC8acrxc4mkA5AI91774270916';
    const DATA_PLANS_URL = 'https://daltechsubapi.com.ng/api/data/'; 

    try {
        if (!db) throw new Error("Firebase not initialized");

        // 1. Fetch current plans from Firebase to preserve custom pricing
        const existingSnap = await db.ref('services/data_plans').once('value');
        const existingPlans = existingSnap.val() || {};

        // 2. Fetch latest plans from DaltechSub
        const response = await axios.get(DATA_PLANS_URL, {
            headers: { 'Authorization': `Token ${DALTECH_KEY}` }
        });

        let plans = response.data;
        if (plans.data && Array.isArray(plans.data)) plans = plans.data;

        if (!Array.isArray(plans)) throw new Error("Invalid provider response format");

        const updates = {};
        const networkMap = { '1': 'mtn', '2': 'glo', '3': 'airtel', '4': '9mobile' };

        plans.forEach(plan => {
            const networkId = String(plan.network);
            const netKey = networkMap[networkId];
            
            if (netKey) {
                const planKey = `plan_${plan.id}`;
                const existingPlan = existingPlans[netKey]?.[planKey];
                const apiCost = Number(plan.amount || plan.price || 0);

                // Use existing price if available, else calculate default
                const sellingPrice = (existingPlan && existingPlan.price) ? existingPlan.price : calculateSellingPrice(apiCost);

                updates[`services/data_plans/${netKey}/${planKey}`] = {
                    name: plan.name || plan.plan_name || 'Unnamed Plan',
                    apiCost: apiCost,
                    validity: plan.month_validate || plan.validity || "30 days",
                    apiPlanId: plan.id,
                    price: sellingPrice
                };
            }
        });

        if (Object.keys(updates).length > 0) {
            await db.ref().update(updates);
            console.log(`[Schedule] Successfully synced ${Object.keys(updates).length} data plans.`);
        }
    } catch (error) {
        console.error("[Schedule] Automated Sync Error:", error.message);
    }
}

// Schedule to run every day at 3:00 AM
cron.schedule('0 3 * * *', () => runDataPlanSync());

// --- 404 Handler for Unknown Routes ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
