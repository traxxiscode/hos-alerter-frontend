/**
 * Geotab HOS Alert Emailer Add-in
 * @returns {{initialize: Function, focus: Function, blur: Function}}
 */
geotab.addin.hosAlerter = function () {
    'use strict';

    let api;
    let state;
    let elAddin;
    let currentDatabase = null;

    // Track cleanup handles so they can be torn down on blur()
    let authUnsubscribe = null;
    let formSubmitHandler = null;
    let listenersBound = false;

    // ── Reset all local state (called on blur and at the top of focus) ──────────

    function resetState() {
        currentDatabase = null;

        // Unsubscribe the Firebase auth listener if one is active
        if (authUnsubscribe) {
            authUnsubscribe();
            authUnsubscribe = null;
        }

        // Tear down the form submit handler
        const form = document.getElementById('addRecipientForm');
        if (form && formSubmitHandler) {
            form.removeEventListener('submit', formSubmitHandler);
            formSubmitHandler = null;
        }
        listenersBound = false;

        // Clear any lingering alerts
        const alertContainer = document.getElementById('alertContainer');
        if (alertContainer) alertContainer.innerHTML = '';

        // Reset the database label back to a loading state
        const dbElement = document.getElementById('currentDatabase');
        if (dbElement) {
            dbElement.innerHTML = `
                <span class="spinner-border spinner-border-sm me-2" role="status">
                    <span class="visually-hidden">Loading...</span>
                </span>
                Loading...
            `;
        }

        // Reset the recipient list back to a loading state
        const recipientsList = document.getElementById('recipientsList');
        if (recipientsList) {
            recipientsList.innerHTML = `
                <div class="list-loading">
                    <div class="d-flex justify-content-center">
                        <div class="spinner-border text-primary" role="status">
                            <span class="visually-hidden">Loading...</span>
                        </div>
                    </div>
                    <div class="text-center mt-2">Loading recipients...</div>
                </div>
            `;
        }

        updateRecipientCount(0);
    }

    // ── Firebase / Firestore helpers ─────────────────────────────────────────────

    /**
     * Ensure the current database document exists in Firestore,
     * then kick off loadRecipients().
     */
    async function ensureDatabaseInFirestore() {
        if (!api || !window.db) return;

        try {
            // Subscribe to auth state — keep the unsubscribe handle so we can
            // clean it up in blur() / resetState().
            await new Promise((resolve, reject) => {
                authUnsubscribe = firebase.auth().onAuthStateChanged(user => {
                    if (user) {
                        resolve(user);
                    } else {
                        firebase.auth().signInAnonymously()
                            .then(resolve)
                            .catch(reject);
                    }
                });
            });

            api.getSession(async function (session) {
                const databaseName = session.database;
                currentDatabase = databaseName;

                const dbElement = document.getElementById('currentDatabase');
                if (dbElement) dbElement.textContent = databaseName;

                if (databaseName && databaseName !== 'demo') {
                    const querySnapshot = await window.db
                        .collection('hos_configurations')
                        .where('database_name', '==', databaseName)
                        .get();

                    if (querySnapshot.empty) {
                        await window.db.collection('hos_configurations').add({
                            database_name: databaseName,
                            recipients: [],
                            created_at: firebase.firestore.FieldValue.serverTimestamp(),
                            updated_at: firebase.firestore.FieldValue.serverTimestamp(),
                            active: true
                        });
                        console.log(`[hosAlerter] Created HOS config for ${databaseName}`);
                    } else {
                        console.log(`[hosAlerter] HOS config already exists for ${databaseName}`);
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
        const overlay = document.getElementById('initialLoadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    function showInitialLoading() {
        const overlay = document.getElementById('initialLoadingOverlay');
        if (overlay) overlay.style.display = 'flex';
    }

    // ── Button loading state ─────────────────────────────────────────────────────

    function setButtonLoading(buttonId, loading = true) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        const btnText = button.querySelector('.btn-text');
        const btnLoadingText = button.querySelector('.btn-loading-text');

        button.disabled = loading;
        if (btnText) btnText.style.display = loading ? 'none' : 'inline-flex';
        if (btnLoadingText) btnLoadingText.style.display = loading ? 'inline-flex' : 'none';
    }

    // ── Recipient CRUD ───────────────────────────────────────────────────────────

    async function loadRecipients() {
        if (!currentDatabase || !window.db) {
            showAlert('Database not initialized', 'danger');
            hideInitialLoading();
            return;
        }

        try {
            const querySnapshot = await window.db
                .collection('hos_configurations')
                .where('database_name', '==', currentDatabase)
                .get();

            if (!querySnapshot.empty) {
                const data = querySnapshot.docs[0].data();
                const recipients = data.recipients || [];
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
        if (!currentDatabase || !window.db) {
            showAlert('Database not initialized', 'danger');
            return;
        }

        setButtonLoading('addRecipientBtn', true);

        try {
            const querySnapshot = await window.db
                .collection('hos_configurations')
                .where('database_name', '==', currentDatabase)
                .get();

            if (!querySnapshot.empty) {
                const doc = querySnapshot.docs[0];
                const recipients = doc.data().recipients || [];

                if (recipients.find(r => r.email === email)) {
                    showAlert('Recipient already exists', 'warning');
                    return;
                }

                recipients.push({ email, added_at: new Date().toISOString() });

                await doc.ref.update({
                    recipients,
                    updated_at: new Date().toISOString()
                });

                showAlert(`Successfully added ${email} to HOS alert recipients`, 'success');
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
        if (!currentDatabase || !window.db) {
            showAlert('Database not initialized', 'danger');
            return;
        }

        const buttonId = `remove-${email.replace(/[^a-zA-Z0-9]/g, '')}`;
        setButtonLoading(buttonId, true);

        try {
            const querySnapshot = await window.db
                .collection('hos_configurations')
                .where('database_name', '==', currentDatabase)
                .get();

            if (!querySnapshot.empty) {
                const doc = querySnapshot.docs[0];
                const updatedRecipients = (doc.data().recipients || []).filter(r => r.email !== email);

                await doc.ref.update({
                    recipients: updatedRecipients,
                    updated_at: new Date().toISOString()
                });

                showAlert(`Successfully removed ${email} from recipient list`, 'success');
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
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p class="mb-2 fw-bold">No recipients configured</p>
                    <small>Add email addresses to start receiving HOS alerts</small>
                </div>
            `;
            return;
        }

        container.innerHTML = recipients.map(recipient => `
            <div class="recipient-item">
                <div class="flex-grow-1">
                    <div class="recipient-email">${recipient.email}</div>
                </div>
                <button class="btn btn-outline-danger btn-sm btn-loading"
                    onclick="hosAlerterConfirmRemove('${recipient.email}')"
                    id="remove-${recipient.email.replace(/[^a-zA-Z0-9]/g, '')}">
                    <span class="btn-text">
                        <i class="fas fa-trash me-1"></i>Remove
                    </span>
                    <span class="btn-loading-text" style="display: none;">
                        <span class="spinner-border spinner-border-sm me-1" role="status">
                            <span class="visually-hidden">Loading...</span>
                        </span>
                        Removing...
                    </span>
                </button>
            </div>
        `).join('');
    }

    function updateRecipientCount(count) {
        const el = document.getElementById('recipientCount');
        if (el) el.textContent = count;
    }

    // ── Alert banner ─────────────────────────────────────────────────────────────

    function showAlert(message, type = 'info') {
        const alertContainer = document.getElementById('alertContainer');
        if (!alertContainer) return;

        const alertId = 'alert-' + Date.now();
        const iconMap = {
            success: 'check-circle',
            danger: 'exclamation-triangle',
            warning: 'exclamation-triangle',
            info: 'info-circle'
        };

        alertContainer.insertAdjacentHTML('beforeend', `
            <div class="alert alert-${type} alert-dismissible fade show" id="${alertId}" role="alert">
                <i class="fas fa-${iconMap[type]} me-2"></i>
                ${message}
                <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
            </div>
        `);

        setTimeout(() => {
            const alert = document.getElementById(alertId);
            if (alert && typeof bootstrap !== 'undefined' && bootstrap.Alert) {
                new bootstrap.Alert(alert).close();
            }
        }, 5000);
    }

    // ── Global helpers (namespaced to avoid collisions with other add-ins) ───────
    //
    // Using a unique prefix (hosAlerter*) means these won't accidentally clash
    // with identically-named globals from sibling add-ins loaded in the same page.

    window.hosAlerterConfirmRemove = function (email) {
        if (confirm(`Are you sure you want to remove ${email} from HOS alerts?`)) {
            removeRecipient(email);
        }
    };

    window.hosAlerterRefresh = function () {
        setButtonLoading('refreshBtn', true);
        loadRecipients().finally(() => setButtonLoading('refreshBtn', false));
    };

    // ── Event listeners (bound once, cleaned up on blur) ─────────────────────────

    function setupEventListeners() {
        if (listenersBound) return;   // <-- guard: never attach twice

        const form = document.getElementById('addRecipientForm');
        if (form) {
            formSubmitHandler = function (e) {
                e.preventDefault();
                const email = document.getElementById('recipientEmail').value.trim();
                if (!email) {
                    showAlert('Please enter a valid email address', 'warning');
                    return;
                }
                addRecipient(email);
            };
            form.addEventListener('submit', formSubmitHandler);
        }

        listenersBound = true;
    }

    // ── Geotab add-in lifecycle ──────────────────────────────────────────────────

    return {
        initialize: function (freshApi, freshState, initializeCallback) {
            api = freshApi;
            state = freshState;
            elAddin = document.getElementById('hosAlerter');
            if (state.translate) state.translate(elAddin || '');
            initializeCallback();
        },

        focus: function (freshApi, freshState) {
            api = freshApi;
            state = freshState;

            // Always start from a clean slate when this add-in receives focus
            resetState();

            showInitialLoading();
            setupEventListeners();
            ensureDatabaseInFirestore();  // resolves currentDatabase → loadRecipients()

            if (elAddin) elAddin.style.display = 'block';
        },

        blur: function () {
            // Tear everything down so stale state can't leak into other add-ins
            resetState();

            if (elAddin) elAddin.style.display = 'none';
        }
    };
};