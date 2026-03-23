/**
 * Backend Server for POLSA GRADE
 * Handles secure API calls to MaskawaSub, Wallet management, and Logging.
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
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
async function callApi(endpoint, payload) {
    const url = `${MASKAWA_BASE_URL}/${endpoint}`;
    console.log(`Calling VTU API: ${url} | Payload: ${JSON.stringify(payload)}`);
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Token ${VTU_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        // Extract detailed error from provider if available
        let detailedMsg = error.message;
        if (error.response && error.response.data) {
            const data = error.response.data;
            // Check for common error fields from Django/DRF APIs (detail, message, error, or object keys)
            detailedMsg = data.detail || data.message || data.error || (typeof data === 'object' ? JSON.stringify(data) : data);
            console.error(`API Error Response: ${JSON.stringify(data)}`);
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

    const cost = Number(amount);
    const networkId = getNetworkId(network);

    // Declare refs outside try block to ensure they are accessible in catch for status updates
    let userTxRef, adminTxRef;

    try {
        if (!db) {
            throw new Error(`Backend not connected to Firebase: ${initError || 'Check server logs.'}`);
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
            
            // A. Deduct Wallet BEFORE API Call
            const deductionResult = await userRef.child('walletBalance').transaction(current => {
                const bal = Number(current) || 0;
                if (bal < cost) return; // Abort transaction if insufficient
                return bal - cost;
            });

            if (!deductionResult.committed) {
                throw new Error('Insufficient wallet balance.');
            }

            // B. Call Daltechsub API
            try {
                const DALTECH_URL = 'https://daltechsubapi.com.ng/api/rechargepin/';
                const DALTECH_KEY = 'HACC3C3vBis67qwC2tEA0CFbn82l3d7A24exB9z3BJxpoC8acrxc4mkA5AI91774270916';
                const ref = `EPIN_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

                const rcPayload = {
                    network: String(networkId),
                    quantity: String(quantity || 1),
                    plan: String(cost), // Daltech expects amount as 'plan' or denomination
                    businessname: "Prime Biller",
                    ref: ref
                };

                console.log(`Calling Daltech RC: ${JSON.stringify(rcPayload)}`);
                const response = await axios.post(DALTECH_URL, rcPayload, {
                    headers: {
                        'Authorization': `Token ${DALTECH_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });

                data = response.data;
                
                // Validate Success
                const isSuccess = data.status === 'success' || data.Status === 'successful';
                if (!isSuccess) {
                    throw new Error(data.msg || data.message || 'Provider returned failure status');
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

            } catch (error) {
                // C. Refund on Failure
                console.error("RC Purchase Failed, Refunding:", error.message);
                await userRef.child('walletBalance').transaction(current => (Number(current) || 0) + cost);
                throw error; // Re-throw to trigger failure response
            }

        } else {
            // --- STANDARD FLOW (Airtime/Data) ---
            if (service === 'airtime') {
                endpoint = 'topup/';
                payload = { network: networkId, amount: cost, mobile_number: phone_number, Ported_number: true, airtime_type: 'VTU' };
            } else if (service === 'data') {
                endpoint = 'data/';
                payload = { network: networkId, plan: plan, mobile_number: phone_number, Ported_number: true };
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
        console.error('Recharge Error:', error.response?.data || error.message);
        
        // Update logs to Failed
        if (userTxRef && adminTxRef) {
            const failUpdate = { 
                status: 'Failed', 
                reason: error.message,
                providerResponse: error.response?.data || null
            };
            userTxRef.update(failUpdate).catch(console.error);
            adminTxRef.update(failUpdate).catch(console.error);
        }

        res.status(500).json({ success: false, message: error.response?.data?.message || error.message || 'Transaction failed' });
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

// --- 404 Handler for Unknown Routes ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
