// server.js
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const cors = require('cors');
const cron = require('node-cron');
const Stripe = require('stripe');
const admin = require('firebase-admin');

dotenv.config();

// ─── Firebase Admin SDK ────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const firestore = admin.firestore();

// ─── Stripe ────────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── Express Setup ─────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors());

// Lightweight readiness check for clients/load balancers.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ─── Gemini AI ─────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ═══════════════════════════════════════════════════════════════════
// COMPLAINT CLASSIFICATION (existing)
// ═══════════════════════════════════════════════════════════════════
const getClassificationPrompt = (complaintsJson) => `
  You are an expert AI assistant for a society management system. 
  Your task is to classify incoming resident complaints into one of two categories: urgent or normal.

  Use the following criteria for classification:
  * **urgent:** Issues that are a direct threat to safety, security, or health, or involve the total loss of an essential service (e.g., no power, no water, major leak, fire, person stuck in lift).
  * **normal:** All other non-critical issues (e.g., trash overflow, pest control, noise complaint, broken gym equipment, cosmetic requests).

  Classify the following list of complaints. The complaints are in a JSON array format.
  Respond with **only** a valid JSON array of objects, where each object contains the "id" of the complaint and its "priority".

  Example Response:
  [
    { "id": "c1", "priority": "urgent" },
    { "id": "c2", "priority": "normal" }
  ]

  Complaints to classify:
  ${complaintsJson}
`;

const normalizePriority = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'urgent' || text.includes('high')) return 'urgent';
  return 'normal';
};

app.post('/api/classify-complaints', async (req, res) => {
  try {
    const { complaints } = req.body;
    if (!complaints || complaints.length === 0) return res.json([]);

    const complaintsToClassify = complaints.map(c => ({
      id: c.id, title: c.title, description: c.description
    }));

    const prompt = getClassificationPrompt(JSON.stringify(complaintsToClassify, null, 2));
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonResponse = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonResponse);
    const normalized = parsed.map((item) => ({
      id: item.id,
      priority: normalizePriority(item.priority),
    }));
    res.json(normalized);
  } catch (error) {
    console.error('Error classifying complaints:', error);
    res.status(500).json({ error: 'Failed to classify complaints' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CHATBOT FALLBACK
// ═══════════════════════════════════════════════════════════════════
const generateFallbackResponse = async (message) => {
  const prompt = `
    You are a helpful assistant for a residential society management app.
    Keep responses concise, practical, and resident-friendly.
    If the request needs account-specific data, tell the user to open the relevant app section (Bills, Complaints, Profile) and avoid fabricating personal data.

    Resident message:
    "${message}"
  `;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
};

const chatbotFallbackHandler = async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: 'message is required' });
    }

    const reply = await generateFallbackResponse(message);
    res.json({ reply });
  } catch (error) {
    console.error('Error generating chatbot fallback response:', error);
    res.status(500).json({ message: 'Failed to generate fallback response' });
  }
};

app.post('/chatbot/fallback', chatbotFallbackHandler);
app.post('/api/chatbot/fallback', chatbotFallbackHandler);

// ═══════════════════════════════════════════════════════════════════
// LATE PAYMENT PREDICTION (enhanced with 6-month history)
// ═══════════════════════════════════════════════════════════════════
const getLatePaymentPrompt = (billsJson) => `
  You are an AI assistant for a society/apartment management system.
  Analyze the following list of pending bills and predict which ones are at risk of late payment.

  **PRIMARY RULE — 6-Month History:**
  Each bill object includes a "paymentHistory" array showing the last 6 months of payment records.
  - If a resident has been late (status "overdue" or "late") in 3 or more of the last 6 months, mark them as **"High Risk"**.
  - If late 2 times in the last 6 months, mark as **"Medium Risk"**.
  - Otherwise, mark as **"Low Risk"**.

  Also consider secondary factors:
  - How close the due date is to today
  - The bill amount (higher amounts may be paid late)

  For each bill, return a risk level: "High Risk", "Medium Risk", or "Low Risk".

  Respond with **only** a valid JSON array of objects with "id" and "risk" keys.
  Example:
  [
    { "id": "b1", "risk": "High Risk" },
    { "id": "b2", "risk": "Low Risk" }
  ]

  Bills to analyze:
  ${billsJson}
`;

app.post('/api/predict-late-payments', async (req, res) => {
  try {
    const { bills } = req.body;
    if (!bills || bills.length === 0) return res.json([]);

    const prompt = getLatePaymentPrompt(JSON.stringify(bills, null, 2));
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonResponse = text.replace(/```json/g, '').replace(/```/g, '').trim();
    res.json(JSON.parse(jsonResponse));
  } catch (error) {
    console.error('Error predicting late payments:', error);
    res.status(500).json({ error: 'Failed to predict late payments' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EVENT TIME SUGGESTION (existing)
// ═══════════════════════════════════════════════════════════════════
const getEventTimeSuggestionPrompt = (eventDescription, pastEventsJson) => `
  You are an AI assistant for a society/apartment management system.
  The admin wants to schedule a new event. Suggest the best 3 time slots for this event.

  Consider:
  - The nature of the event (e.g., meetings are best on weekday evenings, festivals on weekends)
  - The past events list below to avoid scheduling conflicts or fatigue
  - General best practices for community engagement

  Event description: "${eventDescription}"

  Past events (for context):
  ${pastEventsJson}

  Respond with **only** a valid JSON array of 3 objects, each with "day" (e.g. "Saturday"), "time" (e.g. "6:00 PM"), and "reason" (one sentence).
  Example:
  [
    { "day": "Saturday", "time": "5:00 PM", "reason": "Weekend evenings have the highest attendance." },
    { "day": "Sunday", "time": "10:00 AM", "reason": "Morning slots work well for family events." },
    { "day": "Friday", "time": "7:00 PM", "reason": "End-of-week gathering maximizes turnout." }
  ]
`;

app.post('/api/suggest-event-time', async (req, res) => {
  try {
    const { eventDescription, pastEvents } = req.body;
    if (!eventDescription) return res.status(400).json({ error: 'Event description is required' });

    const prompt = getEventTimeSuggestionPrompt(
      eventDescription,
      JSON.stringify(pastEvents || [], null, 2)
    );
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonResponse = text.replace(/```json/g, '').replace(/```/g, '').trim();
    res.json(JSON.parse(jsonResponse));
  } catch (error) {
    console.error('Error suggesting event time:', error);
    res.status(500).json({ error: 'Failed to suggest event time' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AUTO-GENERATE MONTHLY BILLS
// ═══════════════════════════════════════════════════════════════════

// Bill templates — each resident gets these every month
const BILL_TEMPLATES = [
  { type: 'Maintenance', title: 'Society Maintenance Fee', amount: 2500 },
  { type: 'Water', title: 'Water Charges', amount: 500 },
  { type: 'Electricity', title: 'Electricity Charges', amount: 1200 },
];

/**
 * Core function to generate monthly bills for all residents.
 * Called by cron or the manual trigger endpoint.
 */
async function generateMonthlyBills() {
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Due date: 15th of the billing month
  const dueDate = new Date(now.getFullYear(), now.getMonth(), 15);

  // 1. Get all resident users
  const usersSnap = await firestore.collection('users').where('role', '==', 'resident').get();
  if (usersSnap.empty) {
    console.log('No residents found, skipping bill generation.');
    return { success: true, billsCreated: 0 };
  }

  let billsCreated = 0;
  const batch = firestore.batch();

  for (const userDoc of usersSnap.docs) {
    const userData = userDoc.data();

    // 2. Check if bills already exist for this user + month to avoid duplicates
    const existingSnap = await firestore.collection('bills')
      .where('userId', '==', userDoc.id)
      .where('month', '==', monthStr)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      console.log(`Bills already exist for ${userData.name} (${monthStr}), skipping.`);
      continue;
    }

    // 3. Create one bill per template
    for (const template of BILL_TEMPLATES) {
      const billRef = firestore.collection('bills').doc();
      const residentFlat = userData.flatNumber || userData.houseNumber || 'Unknown';
      batch.set(billRef, {
        title: `${template.title} - ${monthStr}`,
        userId: userDoc.id,
        userName: userData.fullName || userData.name || 'Unknown User',
        houseNumber: residentFlat,
        flatNumber: residentFlat,
        block: userData.block || null,
        floor: userData.floor || null,
        type: template.type,
        amount: template.amount,
        dueDate: admin.firestore.Timestamp.fromDate(dueDate),
        status: 'pending',
        description: `Auto-generated ${template.type.toLowerCase()} bill for ${monthStr}`,
        month: monthStr,
        createdAt: admin.firestore.Timestamp.now(),
        autoGenerated: true,
      });
      billsCreated++;
    }
  }

  await batch.commit();
  console.log(`✅ Auto-generated ${billsCreated} bills for month ${monthStr}`);
  return { success: true, billsCreated, month: monthStr };
}

// ── Cron: Runs at 00:01 on the 1st of every month ──────────────────
cron.schedule('1 0 1 * *', async () => {
  console.log('⏰ Cron triggered: Generating monthly bills...');
  try {
    const result = await generateMonthlyBills();
    console.log('Cron result:', result);
  } catch (error) {
    console.error('Cron bill generation failed:', error);
  }
});

// ── Manual trigger endpoint (for admin / testing) ──────────────────
app.post('/api/generate-monthly-bills', async (req, res) => {
  try {
    const result = await generateMonthlyBills();
    res.json(result);
  } catch (error) {
    console.error('Error generating monthly bills:', error);
    res.status(500).json({ error: 'Failed to generate monthly bills' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// STRIPE PAYMENT
// ═══════════════════════════════════════════════════════════════════

// Create a checkout/payment session for a bill
const createCheckoutSessionHandler = async (req, res) => {
  try {
    const { amount, billId } = req.body;
    if (!amount || !billId) {
      return res.status(400).json({ error: 'amount and billId are required' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: 'inr',
      metadata: { billId },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
};

// Confirm checkout/payment and mark bill as paid in Firestore
const confirmCheckoutSessionHandler = async (req, res) => {
  try {
    const { billId, paymentIntentId } = req.body;
    if (!billId) return res.status(400).json({ error: 'billId is required' });

    const billRef = firestore.collection('bills').doc(billId);
    await billRef.update({
      status: 'paid',
      paidAt: admin.firestore.Timestamp.now(),
      paymentIntentId: paymentIntentId || null,
    });

    res.json({ success: true, billId });
  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
};

// Required contract endpoints
app.post('/payments/create-checkout-session', createCheckoutSessionHandler);
app.post('/payments/confirm-checkout-session', confirmCheckoutSessionHandler);

// Backward-compatible legacy API endpoints
app.post('/api/create-payment-intent', createCheckoutSessionHandler);
app.post('/api/confirm-payment', confirmCheckoutSessionHandler);

// ── Get payment history for a user (last 6 months) ─────────────────
app.get('/api/payment-history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const billsSnap = await firestore.collection('bills')
      .where('userId', '==', userId)
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(sixMonthsAgo))
      .get();

    const history = [];
    billsSnap.forEach(doc => {
      const data = doc.data();
      history.push({
        id: doc.id,
        month: data.month,
        type: data.type,
        amount: data.amount,
        status: data.status,
        dueDate: data.dueDate?.toDate()?.toISOString(),
        paidAt: data.paidAt?.toDate()?.toISOString() || null,
      });
    });

    res.json(history);
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ERROR HANDLING (JSON ONLY)
// ═══════════════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err);

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  return res.status(500).json({ message: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});