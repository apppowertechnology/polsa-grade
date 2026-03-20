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
    console.log(`Calling VTU API: ${url}`);
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Token ${VTU_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        // Append URL to error message for debugging 404s
        error.message = `External API Error [${url}]: ${error.message}`;
        throw error;
    }
}

// --- Endpoints ---

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
    const { userId, service, amount, network, phone_number, plan, planName, quantity } = req.body;

    // Generate a local request ID for tracing logs
    const requestId = `req_${Date.now()}`;

    // --- 1. Disable / Freeze Recharge Card Feature ---
    if (service === 'recharge-card') {
        return res.status(403).json({ 
            success: false, 
            message: 'Recharge card purchase is currently unavailable. Please use airtime or data services.' 
        });
    }

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

    try {
        if (!db) {
            throw new Error(`Backend not connected to Firebase: ${initError || 'Check server logs.'}`);
        }

        // 1. Validate User & Wallet Balance
        const userRef = db.ref(`users/${userId}`);
        const balanceSnap = await userRef.child('walletBalance').once('value');
        const currentBalance = Number(balanceSnap.val()) || 0;

        if (currentBalance < cost) {
            return res.status(400).json({ success: false, message: 'Insufficient wallet balance.' });
        }

        // 2. Prepare Maskawa API Payload
        let endpoint = '';
        let payload = {};

        if (service === 'airtime') {
            endpoint = 'topup/';
            payload = {
                network: networkId,
                amount: cost,
                mobile_number: phone_number,
                Ported_number: true,
                airtime_type: 'VTU'
            };
        } else if (service === 'data') {
            endpoint = 'data/';
            payload = {
                network: networkId,
                plan: plan,
                mobile_number: phone_number
            };
        } else if (service === 'recharge-card') {
            endpoint = 'epin/'; // Ensure endpoint is singular 'epin/' to prevent 404
            payload = {
                network: networkId,
                amount: cost, 
                quantity: quantity || 1
            };
        } else {
            return res.status(400).json({ success: false, message: 'Invalid service type' });
        }

        // 3. Call Maskawa API
        const data = await callApi(endpoint, payload);
        console.log(`[${requestId}] API Response for ${service}:`, JSON.stringify(data));

        // 4. Check API Success (Relaxed Logic)
        // We treat it as success unless there is an explicit failure status.
        // This prevents false errors when the API returns variations of success messages.
        const isExplicitFailure = 
            (data.Status && String(data.Status).toLowerCase().includes('fail')) ||
            (data.status && String(data.status).toLowerCase().includes('fail')) ||
            (data.success === 'false') ||
            (data.success === false);

        if (isExplicitFailure) {
            throw new Error(data.message || data.error || 'Provider returned failure status');
        }

        // 5. Deduct Balance Atomically
        await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);

        // 6. Log Transaction
        // Fix: Ensure plan is never undefined. Use "Airtime" as fallback for airtime service.
        const safePlan = plan || (service === 'airtime' ? 'Airtime' : 'Standard');

        // Construct details object explicitly to prevent undefined values
        const details = {
            network: network || 'N/A',
            phone: phone_number || 'N/A',
            plan: safePlan,
            ...(planName && { planName }), // Only add if defined
            ...(quantity && { quantity })  // Only add if defined
        };

        const txData = {
            type: 'purchase',
            feature: service,
            amount: cost,
            status: 'Successful',
            transactionId: requestId,
            date: new Date().toISOString(),
            details: details
        };
        
        const txRef = await db.ref(`transactions/${userId}`).push(txData);
        const firebaseTxId = txRef.key;
        await db.ref('payments').push({ ...txData, userId, firebaseTxId }); // Admin log

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
