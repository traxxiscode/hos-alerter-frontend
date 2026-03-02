/**
 * Geotab HOS Alert Emailer Add-in
 *
 * Firebase is initialised here — NOT in index.html — so that:
 *  1. The Firebase SDK <script> tags are injected once and only once, even
 *     when multiple add-ins that use Firebase are loaded in the same window.
 *  2. The `firebaseConfig` variable lives inside this IIFE scope and can
 *     never collide with an identically-named const in another add-in's HTML.
 *  3. This add-in gets its own named Firebase app ("hosAlerter") rather than
 *     fighting over the shared [DEFAULT] app.
 *
 * @returns {{initialize: Function, focus: Function, blur: Function}}
 */
geotab.addin.hosAlerter = (function () {
    'use strict';

    // ── Firebase config (scoped — never leaks to window) ────────────────────────
    const HOS_FIREBASE_CONFIG = {
        apiKey:            "AIzaSyCDquA4ZS0rGVpwwMp-e9g0hK4Rnp8Aqxs",
        authDomain:        "hos-volations.firebaseapp.com",
        projectId:         "hos-volations",
        storageBucket:     "hos-volations.firebasestorage.app",
        messagingSenderId: "775730536667",
        appId:             "1:775730536667:web:008b434fc859bb3e232cfe"
    };

    const APP_NAME   = 'hosAlerter';   // unique name — never clashes with [DEFAULT]
    const COLLECTION = 'hos_configurations';

    // Holds the initialised Firebase services for this add-in only
    let fbApp  = null;
    let fbAuth = null;
    let fbDb   = null;

    /**
     * Inject a <script> tag and wait for it to load.
     * If the same src already exists in the document it is skipped silently.
     */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector('script[src="' + src + '"]')) {
                resolve();   // already injected by another add-in — skip
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload  = resolve;
            s.onerror = () => reject(new Error('Failed to load: ' + src));
            document.head.appendChild(s);
        });
    }

    /**
     * Load the Firebase compat SDKs if not already present, then get or create
     * a named app so we never touch the [DEFAULT] slot.
     */
    async function initFirebase() {
        await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js');
        await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js');

        const existing = (firebase.apps || []).find(a => a.name === APP_NAME);
        fbApp  = existing || firebase.initializeApp(HOS_FIREBASE_CONFIG, APP_NAME);
        fbAuth = firebase.auth(fbApp);
        fbDb   = firebase.firestore(fbApp);
    }

    // ── Add-in state ─────────────────────────────────────────────────────────────

    let api              = null;
    let state            = null;
    let elAddin          = null;
    let currentDatabase  = null;
    let authUnsubscribe  = null;
    let formSubmitHandler = null;
    let listenersBound   = false;

    // ── Reset (called on blur and at the top of every focus) ─────────────────────

    function resetState() {
        currentDatabase = null;

        if (authUnsubscribe) {
            authUnsubscribe();
            authUnsubscribe = null;
        }

        const form = document.getElementById('addRecipientForm');
        if (form && formSubmitHandler) {
            form.removeEventListener('submit', formSubmitHandler);
            formSubmitHandler = null;
        }
        listenersBound = false;

        const alertContainer = document.getElementById('alertContainer');
        if (alertContainer) alertContainer.innerHTML = '';

        const dbElement = document.getElementById('currentDatabase');
        if (dbElement) {
            dbElement.innerHTML =
                '<span class="spinner-border spinner-border-sm me-2" role="status">' +
                '<span class="visually-hidden">Loading...</span></span>Loading...';
        }

        const recipientsList = document.getElementById('recipientsList');
        if (recipientsList) {
            recipientsList.innerHTML =
                '<div class="list-loading">' +
                '<div class="d-flex justify-content-center">' +
                '<div class="spinner-border text-primary" role="status">' +
                '<span class="visually-hidden">Loading...</span></div></div>' +
                '<div class="text-center mt-2">Loading recipients...</div></div>';
        }

        updateRecipientCount(0);
    }

    // ── Firebase helpers ─────────────────────────────────────────────────────────

    async function ensureDatabaseInFirestore() {
        if (!api || !fbDb) return;

        try {
            await new Promise((resolve, reject) => {
                authUnsubscribe = fbAuth.onAuthStateChanged(user => {
                    if (user) {
                        resolve(user);
                    } else {
                        fbAuth.signInAnonymously().then(resolve).catch(reject);
                    }
                });
            });

            api.getSession(async function (session) {
                const databaseName = session.database;
                currentDatabase = databaseName;

                const dbElement = document.getElementById('currentDatabase');
                if (dbElement) dbElement.textContent = databaseName;

                if (databaseName && databaseName !== 'demo') {
                    const snap = await fbDb.collection(COLLECTION)
                        .where('database_name', '==', databaseName)
                        .get();

                    if (snap.empty) {
                        await fbDb.collection(COLLECTION).add({
                            database_name: databaseName,
                            recipients:    [],
                            created_at:    firebase.firestore.FieldValue.serverTimestamp(),
                            updated_at:    firebase.firestore.FieldValue.serverTimestamp(),
                            active:        true
                        });
                        console.log('[hosAlerter] Created HOS config for ' + databaseName);
                    } else {
                        console.log('[hosAlerter] HOS config already exists for ' + databaseName);
                    }
                }

                loadRecipients();
            });

        } catch (error) {
            console.error('[hosAlerter] ensureDatabaseInFirestore error:', error);
            showAlert('Error connecting to database: ' + error.message, 'danger');
            hideInitialLoading();
        }
    }

    // ── Loading overlay ──────────────────────────────────────────────────────────

    function hideInitialLoading() {
        const el = document.getElementById('initialLoadingOverlay');
        if (el) el.style.display = 'none';
    }

    function showInitialLoading() {
        const el = document.getElementById('initialLoadingOverlay');
        if (el) el.style.display = 'flex';
    }

    // ── Button loading ───────────────────────────────────────────────────────────

    function setButtonLoading(buttonId, loading) {
        const btn = document.getElementById(buttonId);
        if (!btn) return;
        const btnText    = btn.querySelector('.btn-text');
        const btnLoading = btn.querySelector('.btn-loading-text');
        btn.disabled = loading;
        if (btnText)    btnText.style.display    = loading ? 'none'        : 'inline-flex';
        if (btnLoading) btnLoading.style.display = loading ? 'inline-flex' : 'none';
    }

    // ── Recipient CRUD ───────────────────────────────────────────────────────────

    async function loadRecipients() {
        if (!currentDatabase || !fbDb) {
            showAlert('Database not initialized', 'danger');
            hideInitialLoading();
            return;
        }
        try {
            const snap = await fbDb.collection(COLLECTION)
                .where('database_name', '==', currentDatabase).get();
            if (!snap.empty) {
                const recipients = snap.docs[0].data().recipients || [];
                renderRecipients(recipients);
                updateRecipientCount(recipients.length);
            } else {
                renderRecipients([]);
                updateRecipientCount(0);
            }
        } catch (error) {
            console.error('[hosAlerter] loadRecipients error:', error);
            showAlert('Error loading recipients: ' + error.message, 'danger');
            renderRecipients([]);
            updateRecipientCount(0);
        } finally {
            hideInitialLoading();
        }
    }

    async function addRecipient(email) {
        if (!currentDatabase || !fbDb) { showAlert('Database not initialized', 'danger'); return; }
        setButtonLoading('addRecipientBtn', true);
        try {
            const snap = await fbDb.collection(COLLECTION)
                .where('database_name', '==', currentDatabase).get();
            if (!snap.empty) {
                const doc        = snap.docs[0];
                const recipients = doc.data().recipients || [];
                if (recipients.find(function(r){ return r.email === email; })) {
                    showAlert('Recipient already exists', 'warning');
                    return;
                }
                recipients.push({ email: email, added_at: new Date().toISOString() });
                await doc.ref.update({ recipients: recipients, updated_at: new Date().toISOString() });
                showAlert('Successfully added ' + email + ' to HOS alert recipients', 'success');
                document.getElementById('addRecipientForm').reset();
                loadRecipients();
            } else {
                showAlert('Database configuration not found', 'danger');
            }
        } catch (error) {
            console.error('[hosAlerter] addRecipient error:', error);
            showAlert('Error adding recipient: ' + error.message, 'danger');
        } finally {
            setButtonLoading('addRecipientBtn', false);
        }
    }

    async function removeRecipient(email) {
        if (!currentDatabase || !fbDb) { showAlert('Database not initialized', 'danger'); return; }
        const buttonId = 'remove-' + email.replace(/[^a-zA-Z0-9]/g, '');
        setButtonLoading(buttonId, true);
        try {
            const snap = await fbDb.collection(COLLECTION)
                .where('database_name', '==', currentDatabase).get();
            if (!snap.empty) {
                const doc     = snap.docs[0];
                const updated = (doc.data().recipients || []).filter(function(r){ return r.email !== email; });
                await doc.ref.update({ recipients: updated, updated_at: new Date().toISOString() });
                showAlert('Successfully removed ' + email + ' from recipient list', 'success');
                loadRecipients();
            } else {
                showAlert('Database configuration not found', 'danger');
            }
        } catch (error) {
            console.error('[hosAlerter] removeRecipient error:', error);
            showAlert('Error removing recipient: ' + error.message, 'danger');
        } finally {
            setButtonLoading(buttonId, false);
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────────

    function renderRecipients(recipients) {
        const container = document.getElementById('recipientsList');
        if (!container) return;

        if (recipients.length === 0) {
            container.innerHTML =
                '<div class="empty-state">' +
                '<i class="fas fa-inbox"></i>' +
                '<p class="mb-2 fw-bold">No recipients configured</p>' +
                '<small>Add email addresses to start receiving HOS alerts</small>' +
                '</div>';
            return;
        }

        container.innerHTML = recipients.map(function(r) {
            var safeId = r.email.replace(/[^a-zA-Z0-9]/g, '');
            return '<div class="recipient-item">' +
                '<div class="flex-grow-1"><div class="recipient-email">' + r.email + '</div></div>' +
                '<button class="btn btn-outline-danger btn-sm btn-loading"' +
                ' onclick="hosAlerterConfirmRemove(\'' + r.email + '\')"' +
                ' id="remove-' + safeId + '">' +
                '<span class="btn-text"><i class="fas fa-trash me-1"></i>Remove</span>' +
                '<span class="btn-loading-text" style="display:none;">' +
                '<span class="spinner-border spinner-border-sm me-1" role="status">' +
                '<span class="visually-hidden">Loading...</span></span>Removing...' +
                '</span></button></div>';
        }).join('');
    }

    function updateRecipientCount(count) {
        const el = document.getElementById('recipientCount');
        if (el) el.textContent = count;
    }

    // ── Alert banner ─────────────────────────────────────────────────────────────

    function showAlert(message, type) {
        type = type || 'info';
        const alertContainer = document.getElementById('alertContainer');
        if (!alertContainer) return;
        const alertId = 'alert-' + Date.now();
        const iconMap = { success: 'check-circle', danger: 'exclamation-triangle',
                          warning: 'exclamation-triangle', info: 'info-circle' };
        alertContainer.insertAdjacentHTML('beforeend',
            '<div class="alert alert-' + type + ' alert-dismissible fade show" id="' + alertId + '" role="alert">' +
            '<i class="fas fa-' + iconMap[type] + ' me-2"></i>' + message +
            '<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>');
        setTimeout(function() {
            var el = document.getElementById(alertId);
            if (el && typeof bootstrap !== 'undefined' && bootstrap.Alert) {
                new bootstrap.Alert(el).close();
            }
        }, 5000);
    }

    // ── Namespaced globals ───────────────────────────────────────────────────────

    window.hosAlerterConfirmRemove = function (email) {
        if (confirm('Are you sure you want to remove ' + email + ' from HOS alerts?')) {
            removeRecipient(email);
        }
    };

    window.hosAlerterRefresh = function () {
        setButtonLoading('refreshBtn', true);
        loadRecipients().finally(function() { setButtonLoading('refreshBtn', false); });
    };

    // ── Event listeners ──────────────────────────────────────────────────────────

    function setupEventListeners() {
        if (listenersBound) return;
        const form = document.getElementById('addRecipientForm');
        if (form) {
            formSubmitHandler = function (e) {
                e.preventDefault();
                var email = document.getElementById('recipientEmail').value.trim();
                if (!email) { showAlert('Please enter a valid email address', 'warning'); return; }
                addRecipient(email);
            };
            form.addEventListener('submit', formSubmitHandler);
        }
        listenersBound = true;
    }

    // ── Geotab add-in lifecycle ──────────────────────────────────────────────────

    return {
        initialize: function (freshApi, freshState, initializeCallback) {
            api     = freshApi;
            state   = freshState;
            elAddin = document.getElementById('hosAlerter');
            if (state.translate) state.translate(elAddin || '');
            initializeCallback();
        },

        focus: function (freshApi, freshState) {
            api   = freshApi;
            state = freshState;

            resetState();
            showInitialLoading();
            setupEventListeners();

            initFirebase()
                .then(function() { return ensureDatabaseInFirestore(); })
                .catch(function(err) {
                    console.error('[hosAlerter] Firebase init error:', err);
                    showAlert('Error initialising Firebase: ' + err.message, 'danger');
                    hideInitialLoading();
                });

            if (elAddin) elAddin.style.display = 'block';
        },

        blur: function () {
            resetState();
            if (elAddin) elAddin.style.display = 'none';
        }
    };
})();