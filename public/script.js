// === Estado ===
let isLoggedIn = false;
let authMode = "login";
let analysisCount = 0;
let currentUser = null;
let planInfo = null;
let selectedModel = "fast";
let uploadedFile = null;

// === Theme Toggle ===
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("debugai_theme", next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  btn.textContent = theme === "dark" ? "🌙" : "☀️";
}

// Aplica tema salvo ao carregar
(function applyTheme() {
  const saved = localStorage.getItem("debugai_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  // updateThemeIcon é chamado no DOMContentLoaded
})();

// === Captura código de referral da URL ===
(function captureReferralCode() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref");
  if (ref) {
    // Salva no sessionStorage para usar no registro
    sessionStorage.setItem("debugai_referral", ref);
  }
})();

// === Verifica se já está logado ao carregar a página ===
window.addEventListener("DOMContentLoaded", () => {
  // Aplica ícone do tema
  updateThemeIcon();

  // Preenche campo hidden de referral (se existir na URL ou sessionStorage)
  const refField = document.getElementById("auth-referral-code");
  if (refField) {
    const ref = sessionStorage.getItem("debugai_referral") || new URLSearchParams(window.location.search).get("ref") || "";
    refField.value = ref;
  }

  const token = localStorage.getItem("debugai_token");
  if (token) {
    fetchUser(token);
  } else {
    // Garante que o demo fica bloqueado
    const locked = document.getElementById("demo-locked");
    const unlocked = document.getElementById("demo-unlocked");
    if (locked) locked.style.display = "block";
    if (unlocked) unlocked.style.display = "none";
  }
});

async function fetchUser(token) {
  try {
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      isLoggedIn = true;
      analysisCount = currentUser.analysis_count;

      // Verifica se tem pagamento pendente pra atualizar o plano
      if (currentUser.plan === "free") {
        try {
          const verifyRes = await fetch("/api/payments/verify", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          const verifyData = await verifyRes.json();
          if (verifyData.updated) {
            currentUser.plan = verifyData.plan;
          }
        } catch (e) {}
      }

      await fetchPlanInfo(token);
      await showLoggedInState();
    } else {
      localStorage.removeItem("debugai_token");
    }
  } catch (err) {
    console.error("Erro ao verificar sessão:", err);
  }
}

async function fetchPlanInfo(token) {
  try {
    const res = await fetch("/api/plan", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      planInfo = await res.json();
    }
  } catch (err) {
    console.error("Erro ao buscar plano:", err);
  }
}

async function showLoggedInState() {
  const locked = document.getElementById("demo-locked");
  const unlocked = document.getElementById("demo-unlocked");
  if (locked) locked.style.display = "none";
  if (unlocked) unlocked.style.display = "block";

  // Atualiza stats do demo
  const analysisEl = document.getElementById("analysis-count");
  const limitEl = document.getElementById("analysis-limit");
  const planEl = document.getElementById("user-plan");
  if (analysisEl) analysisEl.textContent = planInfo ? planInfo.analysisUsed : analysisCount;
  if (limitEl) limitEl.textContent = planInfo ? planInfo.analysisLimit : "10";
  if (planEl) planEl.textContent = planInfo ? planInfo.planName : "Grátis";

  // Atualiza barra de progresso
  updateProgressBar();

  // Atualiza header — mostra nome do usuário + link dashboard se Team
  const headerActions = document.getElementById("header-actions");
  const dashboardLink = planInfo && planInfo.plan === "team"
    ? `<a href="/dashboard.html" class="btn-primary-sm" style="font-size:0.8rem;padding:0.4rem 0.9rem;">dashboard</a>`
    : "";

  // Verifica se é admin
  let adminLink = "";
  try {
    const adminRes = await fetch("/api/admin/check", { headers: { Authorization: `Bearer ${localStorage.getItem("debugai_token")}` } });
    const adminData = await adminRes.json();
    if (adminData.isAdmin) {
      adminLink = `<a href="/admin.html" style="color:var(--error);font-size:0.8rem;font-weight:600;">🔐 admin</a>`;
    }
  } catch (e) {}

  headerActions.innerHTML = `
    <button class="theme-toggle" onclick="toggleTheme()" id="theme-toggle" title="Alternar tema">🌙</button>
    <span style="color: var(--text-secondary); font-size: 0.84rem;">olá, <strong style="color: var(--accent);">${currentUser.name}</strong></span>
    <a href="/app.html" class="btn-primary-sm" style="font-size:0.8rem;padding:0.4rem 0.9rem;">usar IA</a>
    <a href="/conta.html" style="color:var(--text-secondary);font-size:0.8rem;">⚙️ conta</a>
    ${dashboardLink}
    ${adminLink}
    <button onclick="logout()" style="background:transparent;border:1px solid var(--border-light);color:var(--text-secondary);padding:0.45rem 1rem;border-radius:8px;font-size:0.8rem;cursor:pointer;font-family:inherit;">sair</button>
  `;
  updateThemeIcon();

  // Bloqueia tab de revisão se plano free
  if (planInfo && !planInfo.features.codeReview) {
    const reviewTab = document.querySelector('.demo-tabs .tab:last-child');
    if (reviewTab) {
      reviewTab.textContent = "revisar código 🔒";
      reviewTab.setAttribute("onclick", "showUpgradeMessage()");
    }
  }

  // Carrega histórico
  loadHistory();

  // Carrega stats pessoais
  loadPersonalStats();

  // Carrega dados de referral
  loadReferral();

  // Atualiza lock do model selector
  updateModelLock();

  // Mostra seção de conta
  const accountSection = document.getElementById("account-section");
  if (accountSection) {
    accountSection.style.display = "block";

    // Mostra botão de cancelar assinatura se plano é pro ou team
    const cancelSection = document.getElementById("cancel-subscription-section");
    if (cancelSection && planInfo && (planInfo.plan === "pro" || planInfo.plan === "team")) {
      cancelSection.style.display = "block";
    }
  }
}

function showUpgradeMessage() {
  alert("⚡ Revisão de código disponível nos planos Pro e Team.\n\nFaça upgrade para desbloquear!");
  const pricingEl = document.getElementById("pricing");
  if (pricingEl) {
    pricingEl.scrollIntoView({ behavior: "smooth" });
  } else {
    window.location.href = "/#pricing";
  }
}

// === Modal ===
function openModal() {
  document.getElementById("login-modal").style.display = "flex";
}

function closeModal() {
  document.getElementById("login-modal").style.display = "none";
}

function switchModalTab(mode) {
  authMode = mode;
  const nameField = document.getElementById("name-field");
  const tabs = document.querySelectorAll(".modal-tab");
  const submitBtn = document.querySelector("#auth-form > button[type='submit']");

  if (mode === "register") {
    nameField.style.display = "block";
    tabs[0].classList.remove("active");
    tabs[1].classList.add("active");
    submitBtn.textContent = "criar conta";
  } else {
    nameField.style.display = "none";
    tabs[0].classList.add("active");
    tabs[1].classList.remove("active");
    submitBtn.textContent = "entrar";
  }
}

async function handleAuth(e) {
  e.preventDefault();

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value.trim();
  const name = document.getElementById("auth-name").value.trim();

  if (!email || !password) {
    return alert("Preencha e-mail e senha.");
  }

  if (authMode === "register" && !name) {
    return alert("Preencha seu nome.");
  }

  const url = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
  const referralCode = document.getElementById("auth-referral-code") ? document.getElementById("auth-referral-code").value : (sessionStorage.getItem("debugai_referral") || "");
  const body = authMode === "register" ? { name, email, password, referralCode } : { email, password };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      return alert(data.error || "Erro ao autenticar.");
    }

    // Salva token e dados do usuário
    localStorage.setItem("debugai_token", data.token);
    currentUser = data.user;
    isLoggedIn = true;
    analysisCount = currentUser.analysis_count;

    await fetchPlanInfo(data.token);
    closeModal();
    await showLoggedInState();
  } catch (err) {
    alert("Erro ao conectar com o servidor.");
    console.error(err);
  }
}

// === Demo Tabs ===
function switchTab(tab) {
  const tabs = document.querySelectorAll(".demo-tabs .tab");
  tabs.forEach((t) => t.classList.remove("active"));

  if (tab === "error") {
    tabs[0].classList.add("active");
    document.getElementById("tab-error").style.display = "block";
    document.getElementById("tab-review").style.display = "none";
  } else {
    tabs[1].classList.add("active");
    document.getElementById("tab-error").style.display = "none";
    document.getElementById("tab-review").style.display = "block";
  }
}

// === Análise de Erro ===
async function analyzeError() {
  // Bloqueia se não está logado
  if (!isLoggedIn || !localStorage.getItem("debugai_token")) {
    alert("Você precisa fazer login para usar o debugAI.");
    openModal();
    return;
  }

  const erro = document.getElementById("error-input").value.trim();
  const contexto = document.getElementById("context-input").value.trim();
  const linguagem = document.getElementById("language-select") ? document.getElementById("language-select").value : "";
  const model = selectedModel || "fast";

  if (!erro) return alert("Cole um erro ou stack trace.");

  document.getElementById("error-loading").style.display = "block";
  document.getElementById("error-result").style.display = "none";

  try {
    const token = localStorage.getItem("debugai_token");
    const res = await fetch("/api/debug", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ erro, contexto, linguagem, model }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.upgrade) {
        alert(data.error + "\n\nClique em 'ver planos' para fazer upgrade.");
        const pEl = document.getElementById("pricing");
        if (pEl) pEl.scrollIntoView({ behavior: "smooth" });
        else window.location.href = "/#pricing";
      } else {
        alert(data.error);
      }
    } else {
      document.getElementById("error-result-text").innerHTML = renderMarkdown(data.resultado);
      document.getElementById("error-result").style.display = "block";
      analysisCount++;
      document.getElementById("analysis-count").textContent = analysisCount;
      updateProgressBar();
      loadHistory();
    }
  } catch (err) {
    alert("Erro ao conectar com a API.");
    console.error(err);
  } finally {
    document.getElementById("error-loading").style.display = "none";
  }
}

// === Revisão de Código ===
async function reviewCode() {
  // Bloqueia se não está logado
  if (!isLoggedIn || !localStorage.getItem("debugai_token")) {
    alert("Você precisa fazer login para usar o debugAI.");
    openModal();
    return;
  }

  const codigo = document.getElementById("review-input").value.trim();

  if (!codigo) return alert("Cole o código para revisão.");

  document.getElementById("review-loading").style.display = "block";
  document.getElementById("review-result").style.display = "none";

  try {
    const token = localStorage.getItem("debugai_token");
    const res = await fetch("/api/debug", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        erro: "Revisão de código solicitada",
        codigo,
        contexto: "O usuário quer uma revisão geral do código.",
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.upgrade) {
        alert(data.error + "\n\nClique em 'ver planos' para fazer upgrade.");
        const pEl = document.getElementById("pricing");
        if (pEl) pEl.scrollIntoView({ behavior: "smooth" });
        else window.location.href = "/#pricing";
      } else {
        alert(data.error);
      }
    } else {
      document.getElementById("review-result-text").innerHTML = renderMarkdown(data.resultado);
      document.getElementById("review-result").style.display = "block";
      analysisCount++;
      document.getElementById("analysis-count").textContent = analysisCount;
      updateProgressBar();
      loadHistory();
    }
  } catch (err) {
    alert("Erro ao conectar com a API.");
    console.error(err);
  } finally {
    document.getElementById("review-loading").style.display = "none";
  }
}

// === Utilitários ===
function logout() {
  localStorage.removeItem("debugai_token");
  isLoggedIn = false;
  currentUser = null;
  planInfo = null;
  window.location.reload();
}

function updateProgressBar() {
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  if (!progressFill || !progressText || !planInfo) return;

  const used = planInfo.analysisUsed || 0;
  const limit = planInfo.analysisLimit;

  if (limit === "ilimitado") {
    progressText.textContent = `${used} (ilimitado)`;
    progressFill.style.width = "100%";
    progressFill.className = "progress-bar-fill";
  } else {
    const numLimit = parseInt(limit);
    const percent = Math.min((used / numLimit) * 100, 100);
    progressText.textContent = `${used}/${numLimit}`;
    progressFill.style.width = `${percent}%`;

    if (percent >= 90) progressFill.className = "progress-bar-fill danger";
    else if (percent >= 70) progressFill.className = "progress-bar-fill warning";
    else progressFill.className = "progress-bar-fill";
  }
}

function renderMarkdown(text) {
  if (!text) return "";
  return text
    // Code blocks (```...```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code (`...`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newline in paragraphs
    .replace(/\n/g, '<br/>')
    // Wrap in paragraph
    .replace(/^(?!<[hupol])(.+)/gm, '<p>$1</p>');
}

function clearInputs(type) {
  if (type === "error") {
    document.getElementById("error-input").value = "";
    document.getElementById("context-input").value = "";
    resetFileUpload();
  } else {
    document.getElementById("review-input").value = "";
  }
}

function copyResult(type) {
  const el = document.getElementById(`${type}-result-text`);
  const text = el.innerText || el.textContent;
  navigator.clipboard.writeText(text).then(() => alert("Copiado!"));
}

function clearResult(type) {
  document.getElementById(`${type}-result-text`).innerHTML = "";
  document.getElementById(`${type}-result`).style.display = "none";
}

// === Pagamento / Stripe ===
async function subscribePlan(plan) {
  const token = localStorage.getItem("debugai_token");

  if (!token) {
    alert("Faça login primeiro para assinar um plano.");
    openModal();
    return;
  }

  try {
    const res = await fetch("/api/payments/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan }),
    });

    const data = await res.json();

    if (!res.ok) {
      return alert(data.error || "Erro ao iniciar pagamento.");
    }

    // Redireciona para o Stripe Checkout
    window.location.href = data.url;
  } catch (err) {
    console.error("Erro no checkout:", err);
    alert("Erro ao conectar com o servidor. Verifique sua conexão.");
  }
}

// === Verifica se voltou do pagamento ===
(async function checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("payment") === "success") {
    const token = localStorage.getItem("debugai_token");
    if (token) {
      // Verifica e atualiza o plano no servidor
      try {
        const res = await fetch("/api/payments/verify", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.updated) {
          alert(`🎉 Pagamento confirmado! Seu plano foi atualizado para ${data.plan.toUpperCase()}.`);
        } else {
          alert("🎉 Pagamento recebido! Seu plano será atualizado em instantes.");
        }
      } catch (e) {
        alert("🎉 Pagamento confirmado! Recarregue a página em alguns segundos.");
      }
    }
    window.history.replaceState({}, "", window.location.pathname);
    window.location.reload();
  } else if (params.get("payment") === "cancel") {
    alert("Pagamento cancelado. Você pode tentar novamente.");
    window.history.replaceState({}, "", window.location.pathname);
  }
})();

// === Histórico ===
let showingFavorites = false;

async function loadHistory() {
  const token = localStorage.getItem("debugai_token");
  if (!token) return;

  try {
    const url = showingFavorites ? "/api/history/favorites" : "/api/history";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return;

    const data = await res.json();
    const section = document.getElementById("history-section");
    const list = document.getElementById("history-list");

    if (data.history.length === 0) {
      section.style.display = "block";
      list.innerHTML = showingFavorites
        ? '<p class="history-empty">Nenhuma análise favoritada ainda.</p>'
        : '<p class="history-empty">Nenhuma análise ainda. Use o debugAI e seu histórico aparecerá aqui.</p>';
      return;
    }

    section.style.display = "block";
    list.innerHTML = data.history.map((item, index) => `
      <div class="history-item">
        <div class="history-item-header">
          <span class="history-item-type ${item.type}">${item.type === "review" ? "revisão" : "erro"}</span>
          <span class="history-item-date">${formatDate(item.created_at)}</span>
        </div>
        <div class="history-item-input">${escapeHtml(item.input_error)}</div>
        <div class="history-item-actions">
          <button class="btn-favorite ${item.is_favorite ? 'active' : ''}" onclick="toggleFavorite(${item.id}, this)">⭐</button>
          <button onclick="shareHistoryItem(${item.id})">🔗 compartilhar</button>
          <button onclick="toggleResponse(${index})">👁 ver resposta</button>
          <button onclick="copyHistoryResponse(${index})">📋 copiar</button>
          <button onclick="deleteHistoryItem(${item.id})">🗑 remover</button>
        </div>
        <div class="history-item-response" id="history-response-${index}">${escapeHtml(item.response)}</div>
      </div>
    `).join("");
  } catch (err) {
    console.error("Erro ao carregar histórico:", err);
  }
}

async function toggleFavorite(id, btn) {
  const token = localStorage.getItem("debugai_token");
  if (!token) return;

  try {
    const res = await fetch(`/api/history/${id}/favorite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.is_favorite) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
      if (showingFavorites) loadHistory();
    }
  } catch (err) {
    console.error("Erro ao favoritar:", err);
  }
}

function filterFavorites() {
  showingFavorites = !showingFavorites;
  const btn = document.getElementById("btn-filter-favorites");
  if (btn) {
    btn.classList.toggle("active", showingFavorites);
  }
  loadHistory();
}

function toggleResponse(index) {
  const el = document.getElementById(`history-response-${index}`);
  el.style.display = el.style.display === "none" || !el.style.display ? "block" : "none";
}

function copyHistoryResponse(index) {
  const el = document.getElementById(`history-response-${index}`);
  navigator.clipboard.writeText(el.textContent).then(() => alert("Copiado!"));
}

async function deleteHistoryItem(id) {
  const token = localStorage.getItem("debugai_token");
  try {
    await fetch(`/api/history/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    loadHistory();
  } catch (err) {
    console.error("Erro ao remover:", err);
  }
}

async function clearAllHistory() {
  if (!confirm("Tem certeza que quer limpar todo o histórico?")) return;
  const token = localStorage.getItem("debugai_token");
  try {
    await fetch("/api/history", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    loadHistory();
  } catch (err) {
    console.error("Erro ao limpar histórico:", err);
  }
}

function formatDate(dateStr) {
  const date = new Date(dateStr + "Z");
  return date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// === Stats Pessoais ===
async function loadPersonalStats() {
  const token = localStorage.getItem("debugai_token");
  if (!token) return;

  const statsSection = document.getElementById("personal-stats");
  if (!statsSection) return;

  try {
    const res = await fetch("/api/stats/personal", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return;

    const data = await res.json();

    statsSection.style.display = "block";
    document.getElementById("stat-bugs").textContent = data.totalBugs;
    document.getElementById("stat-tempo").textContent = data.tempoEconomizado >= 60
      ? `${Math.floor(data.tempoEconomizado / 60)}h ${data.tempoEconomizado % 60}min`
      : `${data.tempoEconomizado} min`;
    document.getElementById("stat-linguagem").textContent = data.linguagemMaisUsada;
    document.getElementById("stat-streak").textContent = `${data.streak} ${data.streak === 1 ? "dia" : "dias"}`;
  } catch (err) {
    console.error("Erro ao carregar stats pessoais:", err);
  }
}


// === Referral / Convide Amigos ===
async function loadReferral() {
  const token = localStorage.getItem("debugai_token");
  if (!token) return;

  const section = document.getElementById("referral-section");
  if (!section) return;

  try {
    const res = await fetch("/api/referral", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return;

    const data = await res.json();

    section.style.display = "block";
    document.getElementById("referral-link").value = data.referralLink;
    document.getElementById("referral-count").textContent = data.referredCount;
    document.getElementById("referral-bonus").textContent = data.bonusAnalyses;
  } catch (err) {
    console.error("Erro ao carregar referral:", err);
  }
}

function copyReferralLink() {
  const input = document.getElementById("referral-link");
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => {
    alert("Link copiado! Compartilhe com seus amigos.");
  });
}

// === Alterar Senha ===
async function changePassword() {
  const currentPassword = document.getElementById("current-password").value.trim();
  const newPassword = document.getElementById("new-password").value.trim();
  const confirmNewPassword = document.getElementById("confirm-new-password").value.trim();

  if (!currentPassword || !newPassword || !confirmNewPassword) {
    return alert("Preencha todos os campos.");
  }

  if (newPassword.length < 6) {
    return alert("Nova senha deve ter pelo menos 6 caracteres.");
  }

  if (newPassword !== confirmNewPassword) {
    return alert("As senhas não coincidem.");
  }

  const token = localStorage.getItem("debugai_token");
  if (!token) {
    return alert("Faça login primeiro.");
  }

  try {
    const res = await fetch("/api/auth/change-password", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    const data = await res.json();

    if (!res.ok) {
      return alert(data.error || "Erro ao alterar senha.");
    }

    alert(data.message || "Senha alterada com sucesso!");
    document.getElementById("current-password").value = "";
    document.getElementById("new-password").value = "";
    document.getElementById("confirm-new-password").value = "";
  } catch (err) {
    console.error("Erro ao alterar senha:", err);
    alert("Erro ao conectar com o servidor.");
  }
}

// === Cancelar Assinatura ===
async function cancelSubscription() {
  if (!confirm("Tem certeza que deseja cancelar sua assinatura?\n\nSeu plano voltará para Grátis e você perderá acesso aos recursos pagos.")) {
    return;
  }

  const token = localStorage.getItem("debugai_token");
  if (!token) {
    return alert("Faça login primeiro.");
  }

  try {
    const res = await fetch("/api/payments/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      return alert(data.error || "Erro ao cancelar assinatura.");
    }

    alert(data.message || "Assinatura cancelada com sucesso!");
    window.location.reload();
  } catch (err) {
    console.error("Erro ao cancelar assinatura:", err);
    alert("Erro ao conectar com o servidor.");
  }
}


// === Model Selector ===
function selectModel(model) {
  // Se tentar selecionar "detailed" e não é Pro/Team, avisa
  if (model === "detailed" && planInfo && planInfo.plan === "free") {
    alert("⚡ Modelo detalhado disponível apenas nos planos Pro e Team.\n\nFaça upgrade para desbloquear!");
    return;
  }

  selectedModel = model;
  const pills = document.querySelectorAll(".model-pill");
  pills.forEach(p => {
    p.classList.toggle("active", p.dataset.model === model);
  });
}

// Atualiza visibilidade do lock no model selector
function updateModelLock() {
  const lockEl = document.getElementById("model-lock");
  if (!lockEl) return;
  if (planInfo && (planInfo.plan === "pro" || planInfo.plan === "team")) {
    lockEl.style.display = "none";
  } else {
    lockEl.style.display = "inline";
  }
}

// === Compartilhar Análise ===
async function shareHistoryItem(id) {
  const token = localStorage.getItem("debugai_token");
  if (!token) return;

  try {
    const res = await fetch(`/api/history/${id}/share`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const data = await res.json();
      return alert(data.error || "Erro ao compartilhar.");
    }

    const data = await res.json();
    navigator.clipboard.writeText(data.shareUrl).then(() => {
      alert("🔗 Link copiado para a área de transferência!\n\n" + data.shareUrl);
    }).catch(() => {
      prompt("Copie o link:", data.shareUrl);
    });
  } catch (err) {
    console.error("Erro ao compartilhar:", err);
    alert("Erro ao gerar link de compartilhamento.");
  }
}

// === Upload de Arquivo ===
function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById("file-upload-area").classList.add("dragover");
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById("file-upload-area").classList.remove("dragover");
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById("file-upload-area").classList.remove("dragover");

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    setUploadedFile(files[0]);
  }
}

function handleFileSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    setUploadedFile(files[0]);
  }
}

function setUploadedFile(file) {
  const allowedExtensions = [".js", ".ts", ".py", ".java", ".php", ".rb", ".go", ".rs", ".cs", ".txt"];
  const ext = "." + file.name.split(".").pop().toLowerCase();

  if (!allowedExtensions.includes(ext)) {
    alert("Tipo de arquivo não permitido. Envie: " + allowedExtensions.join(", "));
    return;
  }

  if (file.size > 200 * 1024) {
    alert("Arquivo muito grande. Limite máximo: 200KB.");
    return;
  }

  uploadedFile = file;
  const area = document.getElementById("file-upload-area");
  const text = document.getElementById("file-upload-text");
  area.classList.add("has-file");
  text.innerHTML = `✅ <strong>${file.name}</strong> (${(file.size / 1024).toFixed(1)}KB)`;
  document.getElementById("btn-upload-analyze").style.display = "inline-block";
}

async function uploadFile() {
  if (!isLoggedIn || !localStorage.getItem("debugai_token")) {
    alert("Você precisa fazer login para usar o debugAI.");
    openModal();
    return;
  }

  if (!uploadedFile) {
    return alert("Selecione um arquivo primeiro.");
  }

  const erro = document.getElementById("error-input").value.trim() || "Análise de arquivo enviado";
  const contexto = document.getElementById("context-input").value.trim();

  document.getElementById("error-loading").style.display = "block";
  document.getElementById("error-result").style.display = "none";

  try {
    const token = localStorage.getItem("debugai_token");
    const formData = new FormData();
    formData.append("file", uploadedFile);
    formData.append("erro", erro);
    formData.append("contexto", contexto);

    const res = await fetch("/api/debug/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.upgrade) {
        alert(data.error);
      } else {
        alert(data.error);
      }
    } else {
      document.getElementById("error-result-text").innerHTML = renderMarkdown(data.resultado);
      document.getElementById("error-result").style.display = "block";
      analysisCount++;
      document.getElementById("analysis-count").textContent = analysisCount;
      updateProgressBar();
      loadHistory();
      // Reset file upload
      resetFileUpload();
    }
  } catch (err) {
    alert("Erro ao conectar com a API.");
    console.error(err);
  } finally {
    document.getElementById("error-loading").style.display = "none";
  }
}

function resetFileUpload() {
  uploadedFile = null;
  const area = document.getElementById("file-upload-area");
  const text = document.getElementById("file-upload-text");
  if (area) {
    area.classList.remove("has-file");
    text.innerHTML = '📁 arraste um arquivo aqui ou <strong>escolha arquivo</strong>';
  }
  const input = document.getElementById("file-input");
  if (input) input.value = "";
  const btn = document.getElementById("btn-upload-analyze");
  if (btn) btn.style.display = "none";
}
