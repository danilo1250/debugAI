const express = require("express");
const db = require("./database");

const router = express.Router();

// Inicializa Stripe com a chave secreta
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Preços dos planos — você precisa criar esses produtos no Stripe Dashboard
// e colocar os Price IDs aqui (começam com price_...)
const PLANS = {
  pro: {
    priceId: process.env.STRIPE_PRICE_PRO, // price_xxxx do Stripe
    name: "Pro",
    analysisLimit: -1, // ilimitado
  },
  team: {
    priceId: process.env.STRIPE_PRICE_TEAM, // price_xxxx do Stripe
    name: "Team",
    analysisLimit: -1, // ilimitado
  },
};

// === CRIAR SESSÃO DE CHECKOUT ===
router.post("/checkout", async (req, res) => {
  const { plan } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Faça login primeiro." });
  }

  const jwt = require("jsonwebtoken");
  const JWT_SECRET = process.env.JWT_SECRET || "debugai-secret-key-change-me";

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

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  try {
    // Tenta criar sessão de assinatura (recorrente)
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "subscription",
        customer_email: user.email,
        line_items: [
          {
            price: PLANS[plan].priceId,
            quantity: 1,
          },
        ],
        metadata: {
          userId: String(userId),
          plan: plan,
        },
        success_url: `${process.env.BASE_URL || "http://localhost:3000"}/?payment=success`,
        cancel_url: `${process.env.BASE_URL || "http://localhost:3000"}/?payment=cancel`,
      });
    } catch (subErr) {
      // Se falhar como subscription, tenta como pagamento único
      console.log("Tentando como payment ao invés de subscription:", subErr.message);
      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: user.email,
        line_items: [
          {
            price: PLANS[plan].priceId,
            quantity: 1,
          },
        ],
        metadata: {
          userId: String(userId),
          plan: plan,
        },
        success_url: `${process.env.BASE_URL || "http://localhost:3000"}/?payment=success`,
        cancel_url: `${process.env.BASE_URL || "http://localhost:3000"}/?payment=cancel`,
      });
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erro ao criar sessão Stripe:", err.message);
    res.status(500).json({ error: "Erro ao criar sessão de pagamento: " + err.message });
  }
});

// === WEBHOOK DO STRIPE ===
// O Stripe envia notificações aqui quando o pagamento é confirmado
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      // Em desenvolvimento sem webhook secret, aceita direto
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error("Webhook signature inválida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Processa eventos do Stripe
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;

      if (userId && plan) {
        db.prepare("UPDATE users SET plan = ?, stripe_customer_id = ? WHERE id = ?").run(
          plan,
          session.customer,
          parseInt(userId)
        );
        console.log(`✓ Usuário ${userId} atualizado para plano ${plan}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      // Quando a assinatura é cancelada, volta para free
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const user = db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(customerId);
      if (user) {
        db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(user.id);
        console.log(`✓ Usuário ${user.id} voltou para plano free (assinatura cancelada)`);
      }
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
