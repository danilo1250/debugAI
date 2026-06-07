// Configuração dos planos e seus limites
const PLAN_LIMITS = {
  free: {
    name: "Grátis",
    analysisPerMonth: 10,
    features: {
      errorAnalysis: true,
      codeReview: false,
      unlimitedHistory: false,
      teamDashboard: false,
      prioritySupport: false,
      apiAccess: false,
    },
  },
  pro: {
    name: "Pro",
    analysisPerMonth: -1, // ilimitado
    features: {
      errorAnalysis: true,
      codeReview: true,
      unlimitedHistory: true,
      teamDashboard: false,
      prioritySupport: false,
      apiAccess: false,
    },
  },
  team: {
    name: "Team",
    analysisPerMonth: -1, // ilimitado
    maxMembers: 10,
    features: {
      errorAnalysis: true,
      codeReview: true,
      unlimitedHistory: true,
      teamDashboard: true,
      prioritySupport: true,
      apiAccess: true,
    },
  },
};

// Verifica se o usuário pode fazer uma análise (limite mensal)
function canAnalyze(user) {
  const plan = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

  // Plano ilimitado
  if (plan.analysisPerMonth === -1) {
    return { allowed: true, remaining: -1 };
  }

  // Limite total = limite do plano + bônus de referral
  const bonus = user.bonus_analyses || 0;
  const totalLimit = plan.analysisPerMonth + bonus;

  // Verifica se o contador mensal resetou (mês novo)
  const now = new Date();
  const resetDate = user.analysis_reset_date ? new Date(user.analysis_reset_date) : null;

  if (!resetDate || resetDate.getMonth() !== now.getMonth() || resetDate.getFullYear() !== now.getFullYear()) {
    // Novo mês, reseta o contador
    return { allowed: true, remaining: totalLimit, needsReset: true };
  }

  const remaining = totalLimit - user.analysis_count;
  return {
    allowed: remaining > 0,
    remaining: Math.max(0, remaining),
  };
}

// Verifica se o usuário tem acesso a uma feature
function hasFeature(user, feature) {
  const plan = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
  return plan.features[feature] || false;
}

// Retorna info do plano do usuário
function getPlanInfo(user) {
  const plan = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
  const analysis = canAnalyze(user);
  const bonus = user.bonus_analyses || 0;
  const totalLimit = plan.analysisPerMonth === -1 ? -1 : plan.analysisPerMonth + bonus;

  return {
    plan: user.plan || "free",
    planName: plan.name,
    analysisLimit: totalLimit === -1 ? "ilimitado" : totalLimit,
    analysisUsed: user.analysis_count || 0,
    analysisRemaining: analysis.remaining === -1 ? "ilimitado" : analysis.remaining,
    bonusAnalyses: bonus,
    features: plan.features,
  };
}

module.exports = { PLAN_LIMITS, canAnalyze, hasFeature, getPlanInfo };
