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
    const { userId, service, amount, network, phone_number, plan, quantity } = req.body;

    if (!userId || !amount || !service) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
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
            endpoint = 'epins/';
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

        // 4. Check API Success 
        // (Maskawa typically returns a Status field, or implicit success with data)
        if (data.Status && data.Status !== 'successful' && !data.pin && !data.pins && !data.token) {
            throw new Error(data.message || data.error || 'Provider transaction failed');
        }

        // 5. Deduct Balance Atomically
        await userRef.child('walletBalance').transaction(current => (Number(current) || 0) - cost);

        // 6. Log Transaction
        const txData = {
            type: 'purchase',
            feature: service,
            amount: cost,
            status: 'Successful',
            date: new Date().toISOString(),
            details: { network, phone: phone_number, plan, quantity }
        };
        
        await db.ref(`transactions/${userId}`).push(txData);
        await db.ref('payments').push({ ...txData, userId }); // Admin log

        // 7. Return Success
        const pins = data.pins || (data.pin ? [data.pin] : (data.token ? [data.token] : []));
        res.json({ success: true, message: 'Transaction successful', pins: pins, data: data });

    } catch (error) {
        console.error('Recharge Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: error.response?.data?.message || error.message || 'Transaction failed' });
    }
});

// --- 404 Handler for Unknown Routes ---
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
