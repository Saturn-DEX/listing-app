// GitHub API & app configuration
const GITHUB_CONFIG = {
    owner: 'Saturn-DEX',
    repo: 'assets',
    // OAuth App client id (register at github.com/settings/developers, callback = https://listing.saturndex.org)
    clientId: '',
    // Cloudflare Worker that exchanges the OAuth code for a token (keeps client_secret server-side)
    exchangeUrl: 'https://oauth-exchange.saturndex.org/exchange',
    apiBase: 'https://api.github.com',
    // GitHub Pages site on assets/main; serves info.json + logos without API quota
    cdnBase: 'https://github.saturndex.org',
    rawBase: 'https://raw.githubusercontent.com/Saturn-DEX/assets/main'
};

// State
let allTokens = [];
let currentTab = 'browse';
let currentToken = null;
let accessToken = null;
let logoBase64 = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadTokensFromGitHub();
    checkAuth();
});

// Tab Navigation
function showTab(tab) {
    currentTab = tab;
    document.getElementById('browseTab').classList.toggle('hidden', tab !== 'browse');
    document.getElementById('submitTab').classList.toggle('hidden', tab !== 'submit');
    document.getElementById('tabBrowse').classList.toggle('tab-active', tab === 'browse');
    document.getElementById('tabSubmit').classList.toggle('tab-active', tab === 'submit');
}

// ---------- GitHub API helpers ----------

async function githubFetch(path, options = {}) {
    const headers = Object.assign({
        'Accept': 'application/vnd.github.v3+json'
    }, options.headers || {});
    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return fetch(`${GITHUB_CONFIG.apiBase}${path}`, Object.assign({}, options, { headers }));
}

// ---------- Browse ----------

async function loadTokensFromGitHub() {
    const spinner = document.getElementById('loadingSpinner');
    const grid = document.getElementById('tokenGrid');
    const countEl = document.getElementById('tokenCount');

    try {
        spinner.classList.remove('hidden');
        grid.innerHTML = '';

        allTokens = [];

        // Dir listings (2 contents-API calls, no per-token quota)
        const ethTokens = await fetchChainTokens('ethereum');
        allTokens = allTokens.concat(ethTokens);

        const etcTokens = await fetchChainTokens('classic');
        allTokens = allTokens.concat(etcTokens);

        countEl.textContent = `Found ${allTokens.length} tokens`;
        renderTokens(allTokens);

    } catch (error) {
        console.error('Error loading tokens:', error);
        countEl.textContent = 'Error loading tokens. Please try again.';
        showToast('Failed to load tokens');
    } finally {
        spinner.classList.add('hidden');
    }
}

async function fetchChainTokens(chain) {
    const tokens = [];
    try {
        const response = await githubFetch(`/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${chain}`);
        if (!response.ok) throw new Error('Failed to fetch chain listing');

        const contents = await response.json();
        const tokenDirs = contents.filter(item =>
            item.type === 'dir' &&
            item.name.startsWith('0x') &&
            item.name.length === 42
        );

        // Fetch info.json for each token via the Pages CDN (batch to keep it friendly)
        for (let i = 0; i < tokenDirs.length; i += 10) {
            const batch = tokenDirs.slice(i, i + 10);
            const results = await Promise.allSettled(
                batch.map(dir => fetchTokenInfo(chain, dir.name))
            );

            results.forEach((result) => {
                if (result.status === 'fulfilled' && result.value) {
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
        `${GITHUB_CONFIG.rawBase}/${chain}/${address}/info.json`
    ];
    for (const url of urls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            return await response.json();
        } catch (error) {
            // try next source
        }
    }
    return null;
}

// ---------- Render ----------

function renderTokens(tokens) {
    const grid = document.getElementById('tokenGrid');
    grid.innerHTML = '';

    if (tokens.length === 0) {
        grid.innerHTML = '<p class="col-span-3 text-center text-gray-500 py-8">No tokens found</p>';
        return;
    }

    tokens.forEach(token => {
        const card = createTokenCard(token);
        grid.appendChild(card);
    });
}

function createTokenCard(token) {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-lg shadow p-4 cursor-pointer token-card transition-transform hover:shadow-md';
    card.onclick = () => openTokenModal(token);

    const logoUrl = token.logo || `https://ui-avatars.com/api/?name=${encodeURIComponent(token.symbol || 'T')}&background=3b82f6&color=fff&size=80`;
    const chainBadge = token.chain === 'ethereum'
        ? '<span class="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">ETH</span>'
        : '<span class="px-2 py-1 bg-purple-100 text-purple-800 text-xs rounded-full">ETC</span>';

    card.innerHTML = `
        <div class="flex items-center gap-3">
            <img src="${logoUrl}" alt="${token.name}" class="w-12 h-12 rounded-full border" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(token.symbol || 'T')}&background=3b82f6&color=fff&size=48'">
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <h3 class="font-medium text-gray-800 truncate">${escapeHtml(token.name || 'Unknown')}</h3>
                    ${chainBadge}
                </div>
                <p class="text-sm text-gray-500">${escapeHtml(token.symbol || '???')}</p>
            </div>
        </div>
        <p class="text-xs text-gray-400 mt-2 font-mono truncate">${escapeHtml(token.address || '')}</p>
    `;

    return card;
}

// Filter Tokens
function filterTokens() {
    const search = document.getElementById('searchInput').value.toLowerCase();
    const chain = document.getElementById('chainFilter').value;

    let filtered = allTokens;

    if (chain !== 'all') {
        filtered = filtered.filter(t => t.chain === chain);
    }

    if (search) {
        filtered = filtered.filter(t =>
            (t.name && t.name.toLowerCase().includes(search)) ||
            (t.symbol && t.symbol.toLowerCase().includes(search)) ||
            (t.address && t.address.toLowerCase().includes(search))
        );
    }

    document.getElementById('tokenCount').textContent = `Found ${filtered.length} tokens`;
    renderTokens(filtered);
}

// ---------- Token Modal ----------

function openTokenModal(token) {
    currentToken = token;

    document.getElementById('modalTitle').textContent = token.name || 'Unknown Token';
    document.getElementById('modalSymbol').textContent = token.symbol || '???';
    document.getElementById('modalAddress').textContent = token.address || '';
    document.getElementById('modalDecimals').textContent = `Decimals: ${token.decimals || 0}`;

    const logoUrl = token.logo || `https://ui-avatars.com/api/?name=${encodeURIComponent(token.symbol || 'T')}&background=3b82f6&color=fff&size=64`;
    document.getElementById('modalLogo').src = logoUrl;

    // Render social links
    const linksContainer = document.getElementById('modalLinks');
    linksContainer.innerHTML = '';

    const socialLinks = [
        { key: 'website', label: 'Website', icon: '🌐' },
        { key: 'x', label: 'Twitter', icon: '𝕏' },
        { key: 'telegram', label: 'Telegram', icon: '📱' },
        { key: 'discord', label: 'Discord', icon: '💬' },
        { key: 'reddit', label: 'Reddit', icon: '📰' },
        { key: 'facebook', label: 'Facebook', icon: '📘' },
        { key: 'coingecko', label: 'CoinGecko', icon: '🦎' }
    ];

    socialLinks.forEach(social => {
        if (token[social.key]) {
            const link = document.createElement('a');
            link.href = token[social.key];
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = 'px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm hover:bg-gray-200 flex items-center gap-1';
            link.innerHTML = `${social.icon} ${social.label}`;
            linksContainer.appendChild(link);
        }
    });

    document.getElementById('tokenModal').classList.remove('hidden');
}

function closeTokenModal() {
    document.getElementById('tokenModal').classList.add('hidden');
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
        showToast('Please connect to GitHub first');
        return;
    }

    // Switch to submit tab with pre-filled data
    showTab('submit');

    document.getElementById('formChain').value = currentToken.chain || 'ethereum';
    document.getElementById('formAddress').value = currentToken.address || '';
    document.getElementById('formName').value = currentToken.name || '';
    document.getElementById('formSymbol').value = currentToken.symbol || '';
    document.getElementById('formDecimals').value = currentToken.decimals || 18;
    document.getElementById('formWebsite').value = currentToken.website || '';
    document.getElementById('formX').value = currentToken.x || '';
    document.getElementById('formTelegram').value = currentToken.telegram || '';
    document.getElementById('formDiscord').value = currentToken.discord || '';
    document.getElementById('formReddit').value = currentToken.reddit || '';
    document.getElementById('formFacebook').value = currentToken.facebook || '';
    document.getElementById('formCoingecko').value = currentToken.coingecko || '';

    // Show logo preview if exists
    if (currentToken.logo) {
        document.getElementById('logoPreview').classList.remove('hidden');
        document.getElementById('logoPreviewImg').src = currentToken.logo;
    }

    closeTokenModal();
}

// ---------- Form Validation ----------

function validateAddress(input) {
    const address = input.value;
    const errorEl = document.getElementById('addressError');

    if (!address) {
        errorEl.classList.add('hidden');
        return true;
    }

    // Check format
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        errorEl.textContent = 'Invalid address format. Must be 0x followed by 40 hex characters.';
        errorEl.classList.remove('hidden');
        return false;
    }

    // Check lowercase
    if (address !== address.toLowerCase()) {
        errorEl.textContent = 'Address must be lowercase.';
        errorEl.classList.remove('hidden');
        return false;
    }

    errorEl.classList.add('hidden');
    return true;
}

function previewLogo(input) {
    const file = input.files[0];
    const previewContainer = document.getElementById('logoPreview');
    const previewImg = document.getElementById('logoPreviewImg');
    const errorEl = document.getElementById('logoError');

    if (!file) {
        previewContainer.classList.add('hidden');
        logoBase64 = null;
        return;
    }

    // Validate file
    if (file.type !== 'image/png') {
        errorEl.textContent = 'Logo must be a PNG file.';
        errorEl.classList.remove('hidden');
        input.value = '';
        return;
    }

    if (file.size > 500 * 1024) { // 500KB limit
        errorEl.textContent = 'Logo must be under 500KB.';
        errorEl.classList.remove('hidden');
        input.value = '';
        return;
    }

    errorEl.classList.add('hidden');

    const reader = new FileReader();
    reader.onload = (e) => {
        previewImg.src = e.target.result;
        previewContainer.classList.remove('hidden');

        // Extract base64 data (without data:image/png;base64, prefix)
        logoBase64 = e.target.result.split(',')[1];
    };
    reader.readAsDataURL(file);
}

// ---------- GitHub OAuth ----------

function handleGitHubAuth() {
    if (accessToken) {
        // Disconnect
        accessToken = null;
        sessionStorage.removeItem('github_token');
        updateAuthUI();
        showToast('Disconnected from GitHub');
        return;
    }

    if (!GITHUB_CONFIG.clientId) {
        showToast('GitHub OAuth not configured. Please set the Client ID.');
        return;
    }

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CONFIG.clientId}&redirect_uri=${encodeURIComponent(window.location.origin)}&scope=public_repo`;
    window.location.href = authUrl;
}

function checkAuth() {
    // Check URL for OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    if (code && !accessToken) {
        // Exchange code for token via the Cloudflare Worker (secret stays server-side)
        exchangeCodeForToken(code);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
    }

    // Check session storage
    const storedToken = sessionStorage.getItem('github_token');
    if (storedToken) {
        accessToken = storedToken;
        updateAuthUI();
    }
}

async function exchangeCodeForToken(code) {
    showToast('Authenticating with GitHub...');

    try {
        const response = await fetch(GITHUB_CONFIG.exchangeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });

        const data = await response.json();

        if (response.ok && data.access_token) {
            accessToken = data.access_token;
            sessionStorage.setItem('github_token', accessToken);
            updateAuthUI();
            showToast('Connected to GitHub!');
        } else {
            console.error('Auth exchange failed:', data);
            showToast(data.error || 'Authentication failed');
        }
    } catch (error) {
        console.error('Auth error:', error);
        showToast('Authentication failed');
    }
}

function updateAuthUI() {
    const authText = document.getElementById('authText');
    const authBtn = document.getElementById('githubConnect');

    if (accessToken) {
        authText.textContent = 'Disconnect';
        authBtn.classList.remove('bg-gray-800');
        authBtn.classList.add('bg-green-600');
    } else {
        authText.textContent = 'Connect GitHub';
        authBtn.classList.remove('bg-green-600');
        authBtn.classList.add('bg-gray-800');
    }
}

// ---------- Submit Token ----------

function submitToken(event) {
    event.preventDefault();

    if (!accessToken) {
        showToast('Please connect to GitHub first');
        return;
    }

    // Validate
    if (!validateAddress(document.getElementById('formAddress'))) {
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner mx-auto"></div>';

    (async () => {
        try {
            const chain = document.getElementById('formChain').value;
            const address = document.getElementById('formAddress').value.toLowerCase();
            const tokenData = {
                name: document.getElementById('formName').value,
                address: address,
                symbol: document.getElementById('formSymbol').value.toUpperCase(),
                decimals: parseInt(document.getElementById('formDecimals').value),
                logo: `${GITHUB_CONFIG.cdnBase}/${chain}/${address}/logo.png`
            };

            // Add optional social links
            const socialFields = ['website', 'x', 'telegram', 'discord', 'reddit', 'facebook', 'coingecko'];
            socialFields.forEach(field => {
                const value = document.getElementById(`form${field.charAt(0).toUpperCase() + field.slice(1)}`).value;
                if (value) tokenData[field] = value;
            });

            // Create or update files
            const files = [
                {
                    path: `${chain}/${address}/info.json`,
                    content: btoa(JSON.stringify(tokenData, null, 2))
                }
            ];

            // Add logo if uploaded
            if (logoBase64) {
                files.push({
                    path: `${chain}/${address}/logo.png`,
                    content: logoBase64
                });
            }

            // Fork and create PR
            const prUrl = await createPullRequest(chain, address, tokenData.name, files);

            showToast(prUrl ? `PR created: ${prUrl}` : 'Submission already exists as a PR — see your PRs.');
            resetForm();
            showTab('browse');

        } catch (error) {
            console.error('Submit error:', error);
            showToast(`Error: ${error.message}`);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit for Review';
        }
    })();
}

// ---------- GitHub PR Creation ----------

async function createPullRequest(chain, address, tokenName, files) {
    // Step 1: Fork the repository (POST /forks returns the existing fork if already forked)
    const forkResponse = await githubFetch(`/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/forks`, {
        method: 'POST'
    });

    if (!forkResponse.ok) {
        throw new Error('Failed to fork repository');
    }

    const fork = await forkResponse.json();
    const forkOwner = fork.owner.login;

    // Step 2: Wait for the fork to be ready (poll for its default branch ref)
    const baseBranch = 'main';
    await waitForForkReady(forkOwner);

    // Step 3: Create a new branch (422 = branch already exists, which is fine on resubmission)
    const branchName = `token/${chain}/${address}`;
    let branchCreated = false;

    const branchRefResponse = await githubFetch(`/repos/${forkOwner}/${GITHUB_CONFIG.repo}/git/ref/heads/${baseBranch}`);
    if (branchRefResponse.ok) {
        const branchData = await branchRefResponse.json();

        const createRefResponse = await githubFetch(`/repos/${forkOwner}/${GITHUB_CONFIG.repo}/git/refs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ref: `refs/heads/${branchName}`,
                sha: branchData.object.sha
            })
        });

        branchCreated = createRefResponse.ok || createRefResponse.status === 422;
    }

    if (!branchCreated) {
        throw new Error('Failed to create branch on fork');
    }

    // Step 4: Create/update files (sha-aware so edits to existing tokens work)
    for (const file of files) {
        const existingSha = await getFileSha(forkOwner, file.path, branchName);
        const putResponse = await githubFetch(`/repos/${forkOwner}/${GITHUB_CONFIG.repo}/contents/${file.path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Add token: ${tokenName}`,
                content: file.content,
                branch: branchName,
                sha: existingSha || undefined
            })
        });

        if (!putResponse.ok && putResponse.status !== 200 && putResponse.status !== 201) {
            const err = await putResponse.json().catch(() => ({}));
            throw new Error(err.message || 'Failed to write file');
        }
    }

    // Step 5: Create Pull Request (422 = PR already exists for this head)
    const prResponse = await githubFetch(`/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: `Add token: ${tokenName} (${chain})`,
            body: '## Token Listing Request\n\n**Token:** ' + tokenName + '\n**Chain:** ' + chain + '\n**Address:** ' + address + '\n\nThis PR was created via the SaturnDEX Assets Listing page (' + GITHUB_CONFIG.cdnBase + ').',
            head: `${forkOwner}:${branchName}`,
            base: baseBranch
        })
    });

    if (prResponse.status === 422) {
        return null; // PR already exists — flag to the user
    }

    if (!prResponse.ok) {
        const err = await prResponse.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to create PR');
    }

    const prData = await prResponse.json();
    return prData.html_url;
}

async function waitForForkReady(forkOwner, maxAttempts = 15) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = await githubFetch(`/repos/${forkOwner}/${GITHUB_CONFIG.repo}/git/ref/heads/main`);
        if (response.ok) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Fork is taking too long to be ready. Please try again.');
}

async function getFileSha(forkOwner, path, branch) {
    try {
        const response = await githubFetch(`/repos/${forkOwner}/${GITHUB_CONFIG.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.sha || null;
    } catch (error) {
        return null;
    }
}

// ---------- Utilities ----------

function resetForm() {
    document.getElementById('tokenForm').reset();
    document.getElementById('logoPreview').classList.add('hidden');
    document.getElementById('addressError').classList.add('hidden');
    document.getElementById('logoError').classList.add('hidden');
    logoBase64 = null;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message) {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    toastMessage.textContent = message;
    toast.classList.remove('hidden');

    setTimeout(() => {
        toast.classList.add('hidden');
    }, 5000);
}