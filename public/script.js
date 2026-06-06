// === Estado ===
let isLoggedIn = false;
let authMode = "login";
let analysisCount = 0;
let currentUser = null;
let planInfo = null;

// === Verifica se já está logado ao carregar a página ===
window.addEventListener("DOMContentLoaded", () => {
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
    <span style="color: var(--text-secondary); font-size: 0.84rem;">olá, <strong style="color: var(--accent);">${currentUser.name}</strong></span>
    <a href="/app.html" class="btn-primary-sm" style="font-size:0.8rem;padding:0.4rem 0.9rem;">usar IA</a>
    ${dashboardLink}
    ${adminLink}
    <button onclick="logout()" style="background:transparent;border:1px solid var(--border-light);color:var(--text-secondary);padding:0.45rem 1rem;border-radius:8px;font-size:0.8rem;cursor:pointer;font-family:inherit;">sair</button>
  `;

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
  const body = authMode === "register" ? { name, email, password } : { email, password };

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
      body: JSON.stringify({ erro, contexto, linguagem }),
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
async function loadHistory() {
  const token = localStorage.getItem("debugai_token");
  if (!token) return;

  try {
    const res = await fetch("/api/history", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return;

    const data = await res.json();
    const section = document.getElementById("history-section");
    const list = document.getElementById("history-list");

    if (data.history.length === 0) {
      section.style.display = "block";
      list.innerHTML = '<p class="history-empty">Nenhuma análise ainda. Use o debugAI e seu histórico aparecerá aqui.</p>';
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
