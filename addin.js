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

    /**
     * Add current database to Firestore if it doesn't exist
     */
    async function ensureDatabaseInFirestore() {
        if (!api || !window.db) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                firebase.auth().onAuthStateChanged(user => {
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
                if (dbElement) {
                    dbElement.textContent = databaseName;
                }

                if (databaseName && databaseName !== 'demo') {
                    const querySnapshot = await window.db.collection('hos_configurations')
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
                        console.log(`Added database ${databaseName} HOS configuration to Firestore`);
                    } else {
                        console.log(`Database ${databaseName} HOS configuration already exists`);
                    }
                }

                // Now load recipients once we have the database
                loadRecipients();
            });
        } catch (error) {
            console.error('Error ensuring database in Firestore:', error);
            showAlert('Error connecting to database: ' + error.message, 'danger');
            hideInitialLoading();
        }
    }

    /**
     * Show/hide button loading state
     */
    function setButtonLoading(buttonId, loading = true) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        const btnText = button.querySelector('.btn-text');
        const btnLoadingText = button.querySelector('.btn-loading-text');

        if (loading) {
            button.disabled = true;
            if (btnText) btnText.style.display = 'none';
            if (btnLoadingText) btnLoadingText.style.display = 'inline-flex';
        } else {
            button.disabled = false;
            if (btnText) btnText.style.display = 'inline-flex';
            if (btnLoadingText) btnLoadingText.style.display = 'none';
        }
    }

    function hideInitialLoading() {
        const overlay = document.getElementById('initialLoadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    function showInitialLoading() {
        const overlay = document.getElementById('initialLoadingOverlay');
        if (overlay) overlay.style.display = 'flex';
    }

    /**
     * Load recipients from Firestore for the current database
     */
    async function loadRecipients() {
        if (!currentDatabase || !window.db) {
            showAlert('Database not initialized', 'danger');
            hideInitialLoading();
            return;
        }

        try {
            const querySnapshot = await window.db.collection('hos_configurations')
                .where('database_name', '==', currentDatabase)
                .get();

            if (!querySnapshot.empty) {
                const doc = querySnapshot.docs[0];
                const data = doc.data();
                const recipients = data.recipients || [];
                renderRecipients(recipients);
                updateRecipientCount(recipients.length);
            } else {
                renderRecipients([]);
                updateRecipientCount(0);
            }
        } catch (error) {
            console.error('Error loading recipients:', error);
            showAlert('Error loading recipients: ' + error.message, 'danger');
            renderRecipients([]);
            updateRecipientCount(0);
        } finally {
            hideInitialLoading();
        }
    }

    /**
     * Add a recipient to Firestore
     */
    async function addRecipient(email) {
        if (!currentDatabase || !window.db) {
            showAlert('Database not initialized', 'danger');
            return;
        }

        setButtonLoading('addRecipientBtn', true);

        try {
            const querySnapshot = await window.db.collection('hos_configurations')
                .where('database_name', '==', currentDatabase)
                .get();

            if (!querySnapshot.empty) {
                const doc = querySnapshot.docs[0];
                const data = doc.data();
                const recipients = data.recipients || [];

                const existingRecipient = recipients.find(r => r.email === email);
                if (existingRecipient) {
                    showAlert('Recipient already exists', 'warning');
                    return;
                }

                const newRecipient = {
                    email: email,
                    added_at: new Date().toISOString()
                };

                recipients.push(newRecipient);

                await doc.ref.update({
                    recipients: recipients,
                    updated_at: new Date().toISOString()
                });

                showAlert(`Successfully added ${email} to HOS alert recipients`, 'success');
                document.getElementById('addRecipientForm').reset();
                loadRecipients();

            } else {
                showAlert('Database configuration not found', 'danger');
            }
        } catch (error) {
            console.error('Error adding recipient:', error);
            showAlert('Error adding recipient: ' + error.message, 'danger');
        } finally {
            setButtonLoading('addRecipientBtn', false);
        }
    }

    /**
     * Remove a recipient from Firestore
     */
    async function removeRecipient(email) {
        if (!currentDatabase || !window.db) {
            showAlert('Database not initialized', 'danger');
            return;
        }

        const buttonId = `remove-${email.replace(/[^a-zA-Z0-9]/g, '')}`;
        setButtonLoading(buttonId, true);

        try {
            const querySnapshot = await window.db.collection('hos_configurations')
                .where('database_name', '==', currentDatabase)
                .get();

            if (!querySnapshot.empty) {
                const doc = querySnapshot.docs[0];
                const data = doc.data();
                const recipients = data.recipients || [];

                const updatedRecipients = recipients.filter(r => r.email !== email);

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
            console.error('Error removing recipient:', error);
            showAlert('Error removing recipient: ' + error.message, 'danger');
        } finally {
            setButtonLoading(buttonId, false);
        }
    }

    /**
     * Render the recipients list
     */
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

        const recipientsHtml = recipients.map(recipient => `
            <div class="recipient-item">
                <div class="flex-grow-1">
                    <div class="recipient-email">${recipient.email}</div>
                </div>
                <button class="btn btn-outline-danger btn-sm btn-loading"
                    onclick="confirmRemoveRecipient('${recipient.email}')"
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

        container.innerHTML = recipientsHtml;
    }

    function updateRecipientCount(count) {
        const countElement = document.getElementById('recipientCount');
        if (countElement) countElement.textContent = count;
    }

    /**
     * Show a dismissible alert banner
     */
    function showAlert(message, type = 'info') {
        const alertContainer = document.getElementById('alertContainer');
        if (!alertContainer) return;

        const alertId = 'alert-' + Date.now();
        const iconMap = {
            'success': 'check-circle',
            'danger': 'exclamation-triangle',
            'warning': 'exclamation-triangle',
            'info': 'info-circle'
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

    // ── Global helpers (called from inline onclick attributes) ──────────────────

    window.confirmRemoveRecipient = function (email) {
        if (confirm(`Are you sure you want to remove ${email} from HOS alerts?`)) {
            removeRecipient(email);
        }
    };

    window.refreshRecipients = function () {
        setButtonLoading('refreshBtn', true);
        loadRecipients().finally(() => setButtonLoading('refreshBtn', false));
    };

    // ── Event listeners ─────────────────────────────────────────────────────────

    function setupEventListeners() {
        const form = document.getElementById('addRecipientForm');
        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                const email = document.getElementById('recipientEmail').value.trim();
                if (!email) {
                    showAlert('Please enter a valid email address', 'warning');
                    return;
                }
                addRecipient(email);
            });
        }
    }

    // ── Geotab add-in lifecycle ─────────────────────────────────────────────────

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

            showInitialLoading();
            setupEventListeners();
            ensureDatabaseInFirestore();  // sets currentDatabase, then calls loadRecipients()

            if (elAddin) elAddin.style.display = 'block';
        },

        blur: function () {
            if (elAddin) elAddin.style.display = 'none';
        }
    };
};