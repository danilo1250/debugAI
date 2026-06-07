const express = require("express");
const jwt = require("jsonwebtoken");
const { db } = require("./database");

const router = express.Router();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || "debugai-secret-key-change-me";

const PLANS = {
  pro: {
    priceId: process.env.STRIPE_PRICE_PRO,
    name: "Pro",
    analysisLimit: -1,
  },
  team: {
    priceId: process.env.STRIPE_PRICE_TEAM,
    name: "Team",
    analysisLimit: -1,
  },
};

// === CRIAR SESSÃO DE CHECKOUT ===
router.post("/checkout", async (req, res) => {
  const { plan } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Faça login primeiro." });
  }

  let userId;
  try {
    const decoded = jwt.verify(authHeader.replace("Bearer ", ""), JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }

  if (!PLANS[plan]) {
    return res.status(400).json({ error: "Plano inválido. Use 'pro' ou 'team'." });
  }

  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: user.email,
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      metadata: { userId: String(userId), plan },
      success_url: `${process.env.BASE_URL || "http://localhost:3000"}/?payment=success`,
      cancel_url: `${process.env.BASE_URL || "http://localhost:3000"}/?payment=cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erro ao criar sessão Stripe:", err.message);
    res.status(500).json({ error: "Erro ao criar sessão de pagamento: " + err.message });
  }
});

// === VERIFICAR PAGAMENTO (chamado quando o usuário volta do Stripe) ===
router.post("/verify", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  let userId;
  try {
    const decoded = jwt.verify(authHeader.replace("Bearer ", ""), JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }

  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  try {
    // Busca as sessões recentes do Stripe
    const sessions = await stripe.checkout.sessions.list({ limit: 20 });

    console.log(`[verify] Buscando pagamento para user ${userId} (${user.email}). Sessões encontradas: ${sessions.data.length}`);

    // Procura uma sessão completa com o userId nos metadata
    for (const session of sessions.data) {
      console.log(`[verify] Sessão ${session.id}: status=${session.payment_status}, metadata=${JSON.stringify(session.metadata)}`);
      
      if (session.payment_status === "paid" && session.metadata?.userId === String(userId)) {
        const plan = session.metadata?.plan;
        if (plan) {
          await db.prepare("UPDATE users SET plan = ?, stripe_customer_id = ? WHERE id = ?")
            .run(plan, session.customer || null, userId);
          console.log(`[verify] ✓ Plano atualizado para ${plan} (user ${userId})`);
          return res.json({ updated: true, plan });
        }
      }
    }

    console.log(`[verify] Nenhum pagamento encontrado para user ${userId}`);
    res.json({ updated: false });
  } catch (err) {
    console.error("Erro ao verificar pagamento:", err.message);
    res.json({ updated: false, error: err.message });
  }
});

// === WEBHOOK DO STRIPE ===
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (endpointSecret && endpointSecret !== "whsec_COLE_O_WEBHOOK_SECRET_AQUI") {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error("Webhook signature inválida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;

      if (userId && plan) {
        await db.prepare("UPDATE users SET plan = ?, stripe_customer_id = ? WHERE id = ?").run(plan, session.customer, parseInt(userId));
        console.log(`✓ Usuário ${userId} atualizado para plano ${plan}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const user = await db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(customerId);
      if (user) {
        await db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(user.id);
        console.log(`✓ Usuário ${user.id} voltou para plano free`);
      }
      break;
    }
  }

  res.json({ received: true });
});

// === CANCELAR ASSINATURA ===
router.post("/cancel", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Faça login primeiro." });
  }

  let userId;
  try {
    const decoded = jwt.verify(authHeader.replace("Bearer ", ""), JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }

  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: "Nenhuma assinatura encontrada." });
  }

  try {
    // Lista assinaturas ativas do cliente
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripe_customer_id,
      status: "active",
    });

    if (subscriptions.data.length === 0) {
      return res.status(400).json({ error: "Nenhuma assinatura ativa encontrada." });
    }

    // Cancela todas as assinaturas ativas
    for (const sub of subscriptions.data) {
      await stripe.subscriptions.cancel(sub.id);
    }

    // Atualiza plano para free
    await db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(userId);

    console.log(`✓ Assinatura cancelada para user ${userId}`);
    res.json({ message: "Assinatura cancelada com sucesso. Seu plano foi alterado para Grátis." });
  } catch (err) {
    console.error("Erro ao cancelar assinatura:", err.message);
    res.status(500).json({ error: "Erro ao cancelar assinatura: " + err.message });
  }
});

module.exports = router;
