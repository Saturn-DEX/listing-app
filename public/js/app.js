// GitHub API & app configuration
const GITHUB_CONFIG = {
    owner: "Saturn-DEX",
    repo: "assets",
    // OAuth App client id (register at github.com/settings/developers, callback = https://listing.saturndex.org)
    // TODO(deploy): replace with the real Client ID before going live (see DEPLOY.md)
    clientId: "Ov23liyKsXXEb5gDGgxC",
    // Cloudflare Worker that exchanges the OAuth code for a token (keeps client_secret server-side)
    exchangeUrl: "https://oauth-exchange.saturndex.org/exchange",
    apiBase: "https://api.github.com",
    // GitHub Pages site on assets/main; serves info.json + logos without API quota
    cdnBase: "https://github.saturndex.org",
    rawBase: "https://raw.githubusercontent.com/Saturn-DEX/assets/main",
};

// State
const PAGE_SIZE = 100; // tokens per browse page
let allTokens = [];
let currentTab = "browse";
let currentToken = null;
let accessToken = null;
let logoBase64 = null;
let isEditing = false; // true while the form is prefilled for editing an existing token
let currentViewTokens = []; // last rendered (filtered) token list
let currentPage = 1;

// Initialize
document.addEventListener("DOMContentLoaded", () => {
    // DOM event wiring (inline onclick/onsubmit/oninput handlers removed from index.html)
    document
        .getElementById("githubConnect")
        .addEventListener("click", handleGitHubAuth);
    document
        .getElementById("tabBrowse")
        .addEventListener("click", () => showTab("browse"));
    document
        .getElementById("tabSubmit")
        .addEventListener("click", () => showTab("submit"));
    document
        .getElementById("searchInput")
        .addEventListener("input", filterTokens);
    document
        .getElementById("chainFilter")
        .addEventListener("change", filterTokens);
    document
        .getElementById("tokenForm")
        .addEventListener("submit", submitToken);
    document
        .getElementById("formAddress")
        .addEventListener("input", (event) => {
            // Normalize pasted mixed-case (checksummed Etherscan) addresses to
            // the canonical lowercase form stored in the assets repo.
            event.target.value = event.target.value.toLowerCase();
            validateAddress(event.target);
        });
    document
        .getElementById("formLogo")
        .addEventListener("change", () =>
            previewLogo(document.getElementById("formLogo")),
        );
    document.getElementById("tokenModal").addEventListener("click", closeModal);
    document
        .getElementById("modalPanel")
        .addEventListener("click", (event) => event.stopPropagation());
    document
        .getElementById("modalCloseX")
        .addEventListener("click", closeTokenModal);
    document
        .getElementById("modalClose")
        .addEventListener("click", closeTokenModal);
    document
        .getElementById("editTokenBtn")
        .addEventListener("click", editToken);

    loadTokensFromGitHub();
    checkAuth();
});

// Tab Navigation
function showTab(tab) {
    currentTab = tab;
    document
        .getElementById("browseTab")
        .classList.toggle("hidden", tab !== "browse");
    document
        .getElementById("submitTab")
        .classList.toggle("hidden", tab !== "submit");
    document
        .getElementById("tabBrowse")
        .classList.toggle("tab-active", tab === "browse");
    document
        .getElementById("tabSubmit")
        .classList.toggle("tab-active", tab === "submit");
}

// ---------- GitHub API helpers ----------

async function githubFetch(path, options = {}) {
    const headers = Object.assign(
        {
            Accept: "application/vnd.github.v3+json",
        },
        options.headers || {},
    );
    if (accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`;
    }
    return fetch(
        `${GITHUB_CONFIG.apiBase}${path}`,
        Object.assign({}, options, { headers }),
    );
}

// ---------- Browse ----------

async function loadTokensFromGitHub() {
    const spinner = document.getElementById("loadingSpinner");
    const grid = document.getElementById("tokenGrid");
    const countEl = document.getElementById("tokenCount");

    try {
        spinner.classList.remove("hidden");
        grid.innerHTML = "";

        allTokens = [];

        // Dir listings (2 contents-API calls, no per-token quota)
        const ethTokens = await fetchChainTokens("ethereum");
        allTokens = allTokens.concat(ethTokens);

        const etcTokens = await fetchChainTokens("classic");
        allTokens = allTokens.concat(etcTokens);

        countEl.textContent = `Found ${allTokens.length} tokens`;
        renderTokens(allTokens);
    } catch (error) {
        console.error("Error loading tokens:", error);
        countEl.textContent = "Error loading tokens. Please try again.";
        showToast("Failed to load tokens");
    } finally {
        spinner.classList.add("hidden");
    }
}

async function fetchChainTokens(chain) {
    const tokens = [];
    try {
        const response = await githubFetch(
            `/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${chain}`,
        );
        if (!response.ok) throw new Error("Failed to fetch chain listing");

        const contents = await response.json();
        const tokenDirs = contents.filter(
            (item) =>
                item.type === "dir" &&
                item.name.startsWith("0x") &&
                item.name.length === 42,
        );

        // Fetch info.json for each token via the Pages CDN (batch to keep it friendly)
        for (let i = 0; i < tokenDirs.length; i += 10) {
            const batch = tokenDirs.slice(i, i + 10);
            const results = await Promise.allSettled(
                batch.map((dir) => fetchTokenInfo(chain, dir.name)),
            );

            results.forEach((result) => {
                if (result.status === "fulfilled" && result.value) {
                    result.value.chain = chain;
                    tokens.push(result.value);
                }
            });
        }
    } catch (error) {
        console.error(`Error fetching ${chain} tokens:`, error);
    }
    return tokens;
}

async function fetchTokenInfo(chain, address) {
    // Primary: GitHub Pages CDN (no rate limit). Fallback: raw.githubusercontent.com.
    const urls = [
        `${GITHUB_CONFIG.cdnBase}/${chain}/${address}/info.json`,
        `${GITHUB_CONFIG.rawBase}/${chain}/${address}/info.json`,
    ];
    for (const url of urls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            return await response.json();
        } catch {
            // try next source
        }
    }
    return null;
}

// ---------- Render ----------

function renderTokens(tokens) {
    currentViewTokens = tokens;
    currentPage = 1;
    renderBrowse();
}

function renderBrowse() {
    const totalPages = Math.max(
        1,
        Math.ceil(currentViewTokens.length / PAGE_SIZE),
    );
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageTokens = currentViewTokens.slice(start, start + PAGE_SIZE);

    document.getElementById("tokenCount").textContent =
        `Found ${currentViewTokens.length} tokens`;
    renderGrid(pageTokens);
    renderPagination(currentViewTokens.length, currentPage);
}

function renderGrid(tokens) {
    const grid = document.getElementById("tokenGrid");
    grid.innerHTML = "";

    if (tokens.length === 0) {
        grid.innerHTML =
            '<p class="col-span-3 text-center text-gray-500 py-8">No tokens found</p>';
        return;
    }

    tokens.forEach((token) => {
        const card = createTokenCard(token);
        grid.appendChild(card);
    });
}

function renderPagination(total, page) {
    const container = document.getElementById("pagination");
    container.innerHTML = "";

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (totalPages <= 1) return;

    const goTo = (target) => () => goToPage(target);

    // Previous button
    const prev = document.createElement("button");
    prev.textContent = "\u00ab";
    prev.disabled = page === 1;
    prev.className = pageBtnClass(page === 1);
    if (page > 1) prev.onclick = goTo(page - 1);
    container.appendChild(prev);

    // Page numbers: always show first/last/current, plus a window around current
    const pages = new Set([1, totalPages, page]);
    for (let i = page - 2; i <= page + 2; i++) {
        if (i >= 1 && i <= totalPages) pages.add(i);
    }

    let last = 0;
    for (const p of [...pages].sort((a, b) => a - b)) {
        if (p - last > 1) {
            const dots = document.createElement("span");
            dots.textContent = "...";
            dots.className = "px-1 text-gray-400 select-none";
            container.appendChild(dots);
        }
        const btn = document.createElement("button");
        btn.textContent = p;
        btn.disabled = p === page;
        btn.className = pageBtnClass(p === page);
        if (p !== page) btn.onclick = goTo(p);
        container.appendChild(btn);
        last = p;
    }

    // Next button
    const next = document.createElement("button");
    next.textContent = "\u00bb";
    next.disabled = page === totalPages;
    next.className = pageBtnClass(page === totalPages);
    if (page < totalPages) next.onclick = goTo(page + 1);
    container.appendChild(next);
}

function pageBtnClass(active) {
    return active
        ? "w-8 h-8 rounded-lg text-sm font-medium bg-blue-600 text-white cursor-default"
        : "w-8 h-8 rounded-lg text-sm text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed";
}

function goToPage(page) {
    const totalPages = Math.max(
        1,
        Math.ceil(currentViewTokens.length / PAGE_SIZE),
    );
    if (page < 1 || page > totalPages || page === currentPage) return;
    currentPage = page;
    renderBrowse();
}

function createTokenCard(token) {
    const card = document.createElement("div");
    card.className =
        "bg-white rounded-lg shadow p-4 cursor-pointer token-card transition-transform hover:shadow-md";
    card.onclick = () => openTokenModal(token);

    const fallbackAvatar = (size) =>
        `https://ui-avatars.com/api/?name=${encodeURIComponent(token.symbol || "T")}&background=3b82f6&color=fff&size=${size}`;
    const logoUrl = token.logo || fallbackAvatar(80);

    // Card top row: logo + name/badge + symbol
    const row = document.createElement("div");
    row.className = "flex items-center gap-3";

    const img = document.createElement("img");
    img.src = logoUrl;
    img.alt = token.name || token.symbol || "Token";
    img.className = "w-12 h-12 rounded-full border";
    img.onerror = () => {
        img.onerror = null;
        img.src = fallbackAvatar(48);
    };

    const info = document.createElement("div");
    info.className = "flex-1 min-w-0";

    const nameRow = document.createElement("div");
    nameRow.className = "flex items-center gap-2";

    const h3 = document.createElement("h3");
    h3.className = "font-medium text-gray-800 truncate";
    h3.textContent = token.name || "Unknown";

    const badge = document.createElement("span");
    badge.className =
        token.chain === "ethereum"
            ? "px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full"
            : "px-2 py-1 bg-purple-100 text-purple-800 text-xs rounded-full";
    badge.textContent = token.chain === "ethereum" ? "ETH" : "ETC";

    nameRow.appendChild(h3);
    nameRow.appendChild(badge);

    const symbol = document.createElement("p");
    symbol.className = "text-sm text-gray-500";
    symbol.textContent = token.symbol || "???";

    info.appendChild(nameRow);
    info.appendChild(symbol);

    row.appendChild(img);
    row.appendChild(info);

    const address = document.createElement("p");
    address.className = "text-xs text-gray-400 mt-2 font-mono truncate";
    address.textContent = token.address || "";

    card.appendChild(row);
    card.appendChild(address);

    return card;
}

// Filter Tokens
function filterTokens() {
    const search = document.getElementById("searchInput").value.toLowerCase();
    const chain = document.getElementById("chainFilter").value;

    let filtered = allTokens;

    if (chain !== "all") {
        filtered = filtered.filter((t) => t.chain === chain);
    }

    if (search) {
        filtered = filtered.filter(
            (t) =>
                (t.name && t.name.toLowerCase().includes(search)) ||
                (t.symbol && t.symbol.toLowerCase().includes(search)) ||
                (t.address && t.address.toLowerCase().includes(search)),
        );
    }

    document.getElementById("tokenCount").textContent =
        `Found ${filtered.length} tokens`;
    renderTokens(filtered);
}

// ---------- Token Modal ----------

function openTokenModal(token) {
    currentToken = token;

    document.getElementById("modalTitle").textContent =
        token.name || "Unknown Token";
    document.getElementById("modalSymbol").textContent = token.symbol || "???";
    document.getElementById("modalAddress").textContent = token.address || "";
    document.getElementById("modalDecimals").textContent =
        `Decimals: ${token.decimals || 0}`;

    const logoUrl =
        token.logo ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(token.symbol || "T")}&background=3b82f6&color=fff&size=64`;
    document.getElementById("modalLogo").src = logoUrl;

    // Render social links
    const linksContainer = document.getElementById("modalLinks");
    linksContainer.innerHTML = "";

    const socialLinks = [
        { key: "website", label: "Website", icon: "🌐" },
        { key: "x", label: "Twitter", icon: "𝕏" },
        { key: "telegram", label: "Telegram", icon: "📱" },
        { key: "discord", label: "Discord", icon: "💬" },
        { key: "reddit", label: "Reddit", icon: "📰" },
        { key: "facebook", label: "Facebook", icon: "📘" },
        { key: "coingecko", label: "CoinGecko", icon: "🦎" },
    ];

    socialLinks.forEach((social) => {
        if (token[social.key]) {
            const link = document.createElement("a");
            link.href = token[social.key];
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.className =
                "px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm hover:bg-gray-200 flex items-center gap-1";
            link.textContent = `${social.icon} ${social.label}`;
            linksContainer.appendChild(link);
        }
    });

    document.getElementById("tokenModal").classList.remove("hidden");
}

function closeTokenModal() {
    document.getElementById("tokenModal").classList.add("hidden");
    currentToken = null;
}

function closeModal(event) {
    if (event.target === event.currentTarget) {
        closeTokenModal();
    }
}

// Edit Token
function editToken() {
    if (!currentToken) return;

    if (!accessToken) {
        showToast("Please connect to GitHub first");
        return;
    }

    // Switch to submit tab with pre-filled data
    showTab("submit");

    document.getElementById("formChain").value =
        currentToken.chain || "ethereum";
    document.getElementById("formAddress").value = currentToken.address || "";
    document.getElementById("formName").value = currentToken.name || "";
    document.getElementById("formSymbol").value = currentToken.symbol || "";
    document.getElementById("formDecimals").value = currentToken.decimals || 18;
    document.getElementById("formWebsite").value = currentToken.website || "";
    document.getElementById("formX").value = currentToken.x || "";
    document.getElementById("formTelegram").value = currentToken.telegram || "";
    document.getElementById("formDiscord").value = currentToken.discord || "";
    document.getElementById("formReddit").value = currentToken.reddit || "";
    document.getElementById("formFacebook").value = currentToken.facebook || "";
    document.getElementById("formCoingecko").value =
        currentToken.coingecko || "";

    // Show logo preview if exists
    if (currentToken.logo) {
        document.getElementById("logoPreview").classList.remove("hidden");
        document.getElementById("logoPreviewImg").src = currentToken.logo;
    }

    isEditing = true;
    closeTokenModal();
}

// ---------- Form Validation ----------

function validateAddress(input) {
    const address = input.value;
    const errorEl = document.getElementById("addressError");

    if (!address) {
        errorEl.classList.add("hidden");
        return true;
    }

    // Check format
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        errorEl.textContent =
            "Invalid address format. Must be 0x followed by 40 hex characters.";
        errorEl.classList.remove("hidden");
        return false;
    }

    // Mixed-case / checksummed (Etherscan) addresses are accepted here; the
    // submit flow lowercases the address before building files / opening the PR.

    errorEl.classList.add("hidden");
    return true;
}

// --- Aligned helpers (mirror ../assets/.github/scripts/validate-assets.js) ---
function isValidLowerAddress(address) {
    return /^0x[0-9a-f]{40}$/.test(address);
}

function validateRequiredTrimmed(rawValue, label, inputId) {
    const trimmed = (rawValue || "").trim();
    if (trimmed.length === 0) {
        const msg = `${label} is required and must not be empty.`;
        showToast(msg);
        if (inputId) {
            const el = document.getElementById(inputId);
            if (el) el.focus();
        }
        return { ok: false, error: msg };
    }
    return { ok: true, value: trimmed };
}

function validateDecimals(rawValue) {
    const trimmed = (rawValue || "").trim();
    if (trimmed.length === 0) {
        const msg = "Decimals is required.";
        showToast(msg);
        document.getElementById("formDecimals").focus();
        return { ok: false, error: msg };
    }
    const num = Number(trimmed);
    if (
        !Number.isFinite(num) ||
        !Number.isInteger(num) ||
        num < 0 ||
        num > 18
    ) {
        const msg = `Invalid decimals (must be integer 0..18): ${trimmed}`;
        showToast(msg);
        document.getElementById("formDecimals").focus();
        return { ok: false, error: msg };
    }
    return { ok: true, value: num };
}

function validateUrlField(rawValue, fieldName, inputId) {
    if (rawValue === undefined || rawValue === null)
        return { ok: true, value: "" };
    const raw = String(rawValue);
    if (raw.trim().length === 0) {
        // Empty string is treated as "not provided" (assets README: remove the row)
        return { ok: true, value: "" };
    }
    if (raw !== raw.trim()) {
        const msg = `Invalid URL for ${fieldName} (leading/trailing whitespace): "${raw}"`;
        showToast(msg);
        if (inputId) document.getElementById(inputId).focus();
        return { ok: false, error: msg };
    }
    try {
        new URL(raw.trim());
    } catch {
        const msg = `Invalid URL for ${fieldName}: ${raw}`;
        showToast(msg);
        if (inputId) document.getElementById(inputId).focus();
        return { ok: false, error: msg };
    }
    return { ok: true, value: raw.trim() };
}

function previewLogo(input) {
    const file = input.files[0];
    const previewContainer = document.getElementById("logoPreview");
    const previewImg = document.getElementById("logoPreviewImg");
    const errorEl = document.getElementById("logoError");

    if (!file) {
        errorEl.classList.add("hidden");
        previewContainer.classList.add("hidden");
        logoBase64 = null;
        return;
    }

    // Validate file
    if (file.type !== "image/png") {
        errorEl.textContent = "Logo must be a PNG file.";
        errorEl.classList.remove("hidden");
        input.value = "";
        return;
    }

    if (file.size > 500 * 1024) {
        // 500KB limit
        errorEl.textContent = "Logo must be under 500KB.";
        errorEl.classList.remove("hidden");
        input.value = "";
        return;
    }

    errorEl.classList.add("hidden");

    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target.result;

        // Require exact 200x200 dimensions (assets README branding spec)
        const img = new Image();
        img.onload = () => {
            if (img.naturalWidth !== 200 || img.naturalHeight !== 200) {
                errorEl.textContent = `Logo must be exactly 200x200 px (got ${img.naturalWidth}x${img.naturalHeight}).`;
                errorEl.classList.remove("hidden");
                previewContainer.classList.add("hidden");
                input.value = "";
                logoBase64 = null;
                return;
            }

            previewImg.src = dataUrl;
            previewContainer.classList.remove("hidden");

            // Extract base64 data (without data:image/png;base64, prefix)
            logoBase64 = dataUrl.split(",")[1];
        };
        img.onerror = () => {
            errorEl.textContent =
                "Could not read this image. Please upload a valid PNG.";
            errorEl.classList.remove("hidden");
            input.value = "";
            logoBase64 = null;
        };
        img.src = dataUrl;
    };
    reader.readAsDataURL(file);
}

// ---------- GitHub OAuth ----------

function handleGitHubAuth() {
    if (accessToken) {
        // Disconnect
        accessToken = null;
        sessionStorage.removeItem("github_token");
        updateAuthUI();
        showToast("Disconnected from GitHub");
        return;
    }

    if (
        !GITHUB_CONFIG.clientId ||
        GITHUB_CONFIG.clientId.includes("YOUR-OAUTH")
    ) {
        showToast(
            "GitHub OAuth not configured. Please set the Client ID (see DEPLOY.md).",
        );
        return;
    }

    let authTarget = null;
    try {
        const authUrl = new URL(
            `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CONFIG.clientId)}&redirect_uri=${encodeURIComponent(window.location.origin)}&scope=public_repo`,
        );
        if (
            authUrl.protocol === "https:" &&
            authUrl.hostname === "github.com" &&
            authUrl.pathname === "/login/oauth/authorize"
        ) {
            authTarget = authUrl.toString();
        }
    } catch {
        authTarget = null;
    }

    if (!authTarget) {
        showToast("Invalid OAuth authorize URL.");
        return;
    }
    location.assign(authTarget);
}

function checkAuth() {
    // Check URL for OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");

    if (code && !accessToken) {
        // Exchange code for token via the Cloudflare Worker (secret stays server-side)
        exchangeCodeForToken(code);
        // Clean URL
        window.history.replaceState(
            {},
            document.title,
            window.location.pathname,
        );
        return;
    }

    // Check session storage
    const storedToken = sessionStorage.getItem("github_token");
    if (storedToken) {
        accessToken = storedToken;
        updateAuthUI();
    }
}

async function exchangeCodeForToken(code) {
    showToast("Authenticating with GitHub...");

    try {
        const response = await fetch(GITHUB_CONFIG.exchangeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
        });

        const data = await response.json();

        if (response.ok && data.access_token) {
            accessToken = data.access_token;
            sessionStorage.setItem("github_token", accessToken);
            updateAuthUI();
            showToast("Connected to GitHub!");
        } else {
            console.error("Auth exchange failed:", data);
            showToast(data.error || "Authentication failed");
        }
    } catch (error) {
        console.error("Auth error:", error);
        showToast("Authentication failed");
    }
}

function updateAuthUI() {
    const authText = document.getElementById("authText");
    const authBtn = document.getElementById("githubConnect");

    if (accessToken) {
        authText.textContent = "Disconnect";
        authBtn.classList.remove("bg-gray-800");
        authBtn.classList.add("bg-green-600");
    } else {
        authText.textContent = "Connect GitHub";
        authBtn.classList.remove("bg-green-600");
        authBtn.classList.add("bg-gray-800");
    }
}

// ---------- Submit Token ----------

function submitToken(event) {
    event.preventDefault();

    if (!accessToken) {
        showToast("Please connect to GitHub first");
        return;
    }

    // --- Mandatory + format validation (aligned with assets validate-assets.js) ---
    const chain = document.getElementById("formChain").value;
    if (!["ethereum", "classic"].includes(chain)) {
        showToast("Invalid chain selected.");
        return;
    }

    // Address: validate format, then normalize to lowercase for the PR payload
    if (!validateAddress(document.getElementById("formAddress"))) {
        return;
    }
    const rawAddress = document.getElementById("formAddress").value.trim();
    const address = rawAddress.toLowerCase();
    if (!isValidLowerAddress(address)) {
        showToast(
            `Invalid address format: ${rawAddress} (must be 0x + 40 hex, lowercase)`,
        );
        document.getElementById("formAddress").focus();
        return;
    }

    // Name / Symbol: trimmed, non-empty (assets: "must be non-empty")
    const nameRes = validateRequiredTrimmed(
        document.getElementById("formName").value,
        "Name",
        "formName",
    );
    if (!nameRes.ok) return;
    const symbolRes = validateRequiredTrimmed(
        document.getElementById("formSymbol").value,
        "Symbol",
        "formSymbol",
    );
    if (!symbolRes.ok) return;

    // Decimals: integer 0..18
    const decimalsRes = validateDecimals(
        document.getElementById("formDecimals").value,
    );
    if (!decimalsRes.ok) return;

    // Logo is required for fresh listings (edit keeps existing file)
    if (!logoBase64 && !isEditing) {
        const logoInput = document.getElementById("formLogo");
        const logoErrorEl = document.getElementById("logoError");
        logoErrorEl.textContent =
            "Logo is required (200x200 PNG). Pick the logo file to upload.";
        logoErrorEl.classList.remove("hidden");
        logoInput.focus();
        return;
    }

    // Optional URL fields: trim check + new URL() validity (mirrors validate-assets.js)
    const socialFields = [
        "website",
        "x",
        "telegram",
        "discord",
        "reddit",
        "facebook",
        "coingecko",
    ];
    const validatedUrls = {};
    for (const field of socialFields) {
        const inputId = `form${field.charAt(0).toUpperCase() + field.slice(1)}`;
        const raw = document.getElementById(inputId).value;
        const res = validateUrlField(raw, field, inputId);
        if (!res.ok) return;
        if (res.value) validatedUrls[field] = res.value;
    }

    // Best-effort duplicate pre-check (per-chain, case-insensitive) using already-fetched allTokens
    if (!isEditing && allTokens && allTokens.length) {
        const dup = allTokens.find(
            (t) =>
                t.chain === chain &&
                t.address &&
                t.address.toLowerCase() === address,
        );
        if (dup) {
            showToast(
                `Token already listed on ${chain}: ${address} — open it to edit instead.`,
            );
            return;
        }
    }

    const submitBtn = document.getElementById("submitBtn");
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner mx-auto"></div>';

    (async () => {
        try {
            const tokenData = {
                name: nameRes.value,
                address: address,
                symbol: symbolRes.value.toUpperCase(),
                decimals: decimalsRes.value,
                logo: `${GITHUB_CONFIG.cdnBase}/${chain}/${address}/logo.png`,
            };

            // Add validated optional social links (trimmed, non-empty, valid URLs)
            for (const [field, value] of Object.entries(validatedUrls)) {
                tokenData[field] = value;
            }

            // Create or update files
            const files = [
                {
                    path: `${chain}/${address}/info.json`,
                    content: btoa(JSON.stringify(tokenData, null, 2)),
                },
            ];

            // Add logo if uploaded
            if (logoBase64) {
                files.push({
                    path: `${chain}/${address}/logo.png`,
                    content: logoBase64,
                });
            }

            // Fork and create PR
            const prUrl = await createPullRequest(
                chain,
                address,
                tokenData.name,
                files,
            );

            showToast(
                prUrl
                    ? `PR created: ${prUrl}`
                    : "Submission already exists as a PR — see your PRs.",
            );
            resetForm();
            showTab("browse");
        } catch (error) {
            console.error("Submit error:", error);
            showToast(`Error: ${error.message}`);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Submit for Review";
        }
    })();
}

// ---------- GitHub PR Creation ----------

async function createPullRequest(chain, address, tokenName, files) {
    // Upstream default branch (the PR base) — fetched dynamically, never hardcoded.
    const upstreamResponse = await githubFetch(
        `/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}`,
    );
    const upstreamDefaultBranch = upstreamResponse.ok
        ? (await upstreamResponse.json()).default_branch || "main"
        : "main";

    // Step 1: Fork the repository. POST /forks returns:
    //   - the new fork (202) — the normal external-contributor path;
    //   - the submitter's EXISTING personal fork (200) if they already have one;
    //   - the base repository itself (200) when the caller owns/has push access.
    const forkResponse = await githubFetch(
        `/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/forks`,
        {
            method: "POST",
        },
    );

    if (!forkResponse.ok) {
        const err = await forkResponse.json().catch(() => ({}));
        throw new Error(err.message || "Failed to fork repository");
    }

    const fork = await forkResponse.json();
    const ref = await resolveForkReference(fork, upstreamDefaultBranch);
    if (!ref.owner || !ref.repo || !ref.defaultBranch) {
        throw new Error("Could not determine the fork repository");
    }

    // Step 2: Wait for the working repo to expose its default-branch ref.
    // Forks clone asynchronously on GitHub; owners skip this (no clone involved —
    // when the caller owns the base repo, the response IS the base repo).
    if (!ref.isBaseRepo) {
        await waitForForkReady(ref.owner, ref.repo, ref.defaultBranch);
    }

    // Step 3: Create a new branch (422 = branch already exists, which is fine on resubmission)
    const branchName = `token/${chain}/${address}`;
    let branchCreated = false;

    const branchRefResponse = await githubFetch(
        `/repos/${ref.owner}/${ref.repo}/git/ref/heads/${ref.defaultBranch}`,
    );
    if (branchRefResponse.ok) {
        const branchData = await branchRefResponse.json();

        const createRefResponse = await githubFetch(
            `/repos/${ref.owner}/${ref.repo}/git/refs`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ref: `refs/heads/${branchName}`,
                    sha: branchData.object.sha,
                }),
            },
        );

        branchCreated =
            createRefResponse.ok || createRefResponse.status === 422;
    }

    if (!branchCreated) {
        throw new Error("Failed to create branch on fork");
    }

    // Step 4: Create/update files (sha-aware so edits to existing tokens work)
    for (const file of files) {
        const existingSha = await getFileSha(
            ref.owner,
            ref.repo,
            file.path,
            branchName,
        );
        const putResponse = await githubFetch(
            `/repos/${ref.owner}/${ref.repo}/contents/${file.path}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: `Add token: ${tokenName}`,
                    content: file.content,
                    branch: branchName,
                    sha: existingSha || undefined,
                }),
            },
        );

        if (
            !putResponse.ok &&
            putResponse.status !== 200 &&
            putResponse.status !== 201
        ) {
            const err = await putResponse.json().catch(() => ({}));
            throw new Error(err.message || "Failed to write file");
        }
    }

    // Step 5: Create Pull Request (422 = PR already exists for this head)
    const prResponse = await githubFetch(
        `/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/pulls`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: `Add token: ${tokenName} (${chain})`,
                body:
                    "## Token Listing Request\n\n**Token:** " +
                    tokenName +
                    "\n**Chain:** " +
                    chain +
                    "\n**Address:** " +
                    address +
                    "\n\nThis PR was created via the SaturnDEX Assets Listing page (" +
                    window.location.origin +
                    ").",
                head: `${ref.owner}:${branchName}`,
                base: upstreamDefaultBranch,
            }),
        },
    );

    if (prResponse.status === 422) {
        return null; // PR already exists — flag to the user
    }

    if (!prResponse.ok) {
        const err = await prResponse.json().catch(() => ({}));
        throw new Error(err.message || "Failed to create PR");
    }

    const prData = await prResponse.json();
    return prData.html_url;
}

// Resolve the REAL identity of the repository the fork response points at.
// GitHub never guarantees the fork keeps the original repo name (it appends
// -1/-2 when the name is already taken) and returns the submitter's existing
// fork or even the base repo itself for owners, so the fork's path must come
// from the response (full_name), never reconstructed as owner + config repo.
async function resolveForkReference(fork, fallbackDefaultBranch) {
    const fullName = fork && fork.full_name;
    let owner = fullName ? fullName.split("/")[0] : null;
    let repo = fullName ? fullName.split("/")[1] : null;
    let defaultBranch =
        (fork && fork.default_branch) || fallbackDefaultBranch || null;

    // Defensive fallback: if the response lacked identity fields, resolve them
    // from the repo resource.
    if ((!owner || !repo || !fork.default_branch) && owner && repo) {
        const probe = await githubFetch(`/repos/${owner}/${repo}`);
        if (probe.ok) {
            const data = await probe.json();
            owner = (data.owner && data.owner.login) || owner;
            repo = data.name || repo;
            defaultBranch = data.default_branch || defaultBranch;
        }
    }

    const effectiveFullName = owner && repo ? `${owner}/${repo}` : null;
    return {
        owner,
        repo,
        defaultBranch,
        isBaseRepo:
            effectiveFullName ===
            `${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}`,
    };
}

async function waitForForkReady(
    forkOwner,
    forkRepo,
    defaultBranch,
    maxAttempts = 14,
) {
    // Fork creation is asynchronous on GitHub: the repo appears immediately but
    // its git refs can take seconds (sometimes minutes, per GitHub docs) to
    // materialize. Poll with backoff and distinguish "still cloning" (repo
    // resource exists, ref not yet) from "repo truly gone" (repo resource 404).
    let delay = 1000;
    let missingRepoCount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const refResponse = await githubFetch(
            `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${defaultBranch}`,
        );
        if (refResponse.ok) return;

        const repoResponse = await githubFetch(
            `/repos/${forkOwner}/${forkRepo}`,
        );
        if (repoResponse.ok) {
            missingRepoCount = 0;
        } else if (repoResponse.status === 404) {
            missingRepoCount++;
            if (missingRepoCount >= 5) {
                throw new Error(
                    `Could not find fork ${forkOwner}/${forkRepo} — see https://github.com/${forkOwner}/${forkRepo}. It may not have been created yet.`,
                );
            }
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 8000);
    }

    throw new Error(
        `Your fork https://github.com/${forkOwner}/${forkRepo} is still being created — GitHub clones forks asynchronously and it can take a while. Check the link and try again.`,
    );
}

async function getFileSha(forkOwner, forkRepo, path, branch) {
    try {
        const response = await githubFetch(
            `/repos/${forkOwner}/${forkRepo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
        );
        if (!response.ok) return null;
        const data = await response.json();
        return data.sha || null;
    } catch {
        return null;
    }
}

// ---------- Utilities ----------

function resetForm() {
    document.getElementById("tokenForm").reset();
    document.getElementById("logoPreview").classList.add("hidden");
    document.getElementById("addressError").classList.add("hidden");
    document.getElementById("logoError").classList.add("hidden");
    logoBase64 = null;
    isEditing = false;
}

function showToast(message) {
    const toast = document.getElementById("toast");
    const toastMessage = document.getElementById("toastMessage");
    toastMessage.textContent = message;
    toast.classList.remove("hidden");

    setTimeout(() => {
        toast.classList.add("hidden");
    }, 5000);
}
