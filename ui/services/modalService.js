/**
 * Modal Service - Provides styled modals matching the app's design
 */

const modalService = {
    /**
     * Show a confirmation modal
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {string} confirmText - Confirm button text
     * @param {string} cancelText - Cancel button text
     * @returns {Promise<boolean>} - True if confirmed, false if cancelled
     */
    confirm(title, message, confirmText = 'Confirm', cancelText = 'Cancel') {
        return new Promise((resolve) => {
            const modal = this._createModal(title, message, true);
            const confirmBtn = modal.querySelector('.__modal-confirm');
            const cancelBtn = modal.querySelector('.__modal-cancel');

            confirmBtn.textContent = confirmText;
            cancelBtn.textContent = cancelText;

            confirmBtn.addEventListener('click', () => {
                this._closeModal(modal);
                resolve(true);
            });

            cancelBtn.addEventListener('click', () => {
                this._closeModal(modal);
                resolve(false);
            });

            // Close on backdrop click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this._closeModal(modal);
                    resolve(false);
                }
            });

            this._bindEscKey(modal, () => resolve(false));
        });
    },

    /**
     * Show an alert modal
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {string} buttonText - Button text
     * @returns {Promise<void>}
     */
    alert(title, message, buttonText = 'OK') {
        return new Promise((resolve) => {
            const modal = this._createModal(title, message, false);
            const okBtn = modal.querySelector('.__modal-confirm');

            okBtn.textContent = buttonText;

            okBtn.addEventListener('click', () => {
                this._closeModal(modal);
                resolve();
            });

            // Close on backdrop click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this._closeModal(modal);
                    resolve();
                }
            });

            this._bindEscKey(modal, () => resolve());
        });
    },

    /**
     * Show a modal with multiple choices
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {Array<{text: string, value: string, primary?: boolean}>} buttons - Button definitions
     * @returns {Promise<string|null>} - The value of the clicked button, or null if dismissed
     */
    choice(title, message, buttons) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = '__modal-overlay';

            const content = document.createElement('div');
            content.className = '__modal-content';

            const titleEl = document.createElement('h2');
            titleEl.className = '__modal-title';
            titleEl.textContent = title;

            const messageEl = document.createElement('p');
            messageEl.className = '__modal-message';
            messageEl.textContent = message;

            const buttonsContainer = document.createElement('div');
            buttonsContainer.className = '__modal-buttons';

            buttons.forEach(btn => {
                const btnEl = document.createElement('button');
                btnEl.className = btn.primary ? '__modal-btn-primary' : '__modal-btn-secondary';
                btnEl.textContent = btn.text;
                btnEl.addEventListener('click', () => {
                    this._closeModal(modal);
                    resolve(btn.value);
                });
                buttonsContainer.appendChild(btnEl);
            });

            content.appendChild(titleEl);
            content.appendChild(messageEl);
            content.appendChild(buttonsContainer);
            modal.appendChild(content);
            document.body.appendChild(modal);

            requestAnimationFrame(() => modal.classList.add('__modal-visible'));

            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this._closeModal(modal);
                    resolve(null);
                }
            });

            this._bindEscKey(modal, () => resolve(null));
        });
    },

    /**
     * Create the modal DOM structure
     */
    _createModal(title, message, showCancel) {
        const modal = document.createElement('div');
        modal.className = '__modal-overlay';

        const content = document.createElement('div');
        content.className = '__modal-content';

        const titleEl = document.createElement('h2');
        titleEl.className = '__modal-title';
        titleEl.textContent = title;

        const messageEl = document.createElement('p');
        messageEl.className = '__modal-message';
        messageEl.textContent = message;

        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = '__modal-buttons';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = '__modal-confirm __modal-btn-primary';

        if (showCancel) {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = '__modal-cancel __modal-btn-secondary';
            buttonsContainer.appendChild(cancelBtn);
        }

        buttonsContainer.appendChild(confirmBtn);

        content.appendChild(titleEl);
        content.appendChild(messageEl);
        content.appendChild(buttonsContainer);

        modal.appendChild(content);
        document.body.appendChild(modal);

        // Trigger animation
        requestAnimationFrame(() => {
            modal.classList.add('__modal-visible');
        });

        return modal;
    },

    /**
     * Bind ESC key to close modal
     */
    _bindEscKey(modal, onClose) {
        const handler = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', handler);
                this._closeModal(modal);
                onClose();
            }
        };
        document.addEventListener('keydown', handler);
    },

    /**
     * Close and remove the modal
     */
    _closeModal(modal) {
        modal.classList.remove('__modal-visible');
        modal.addEventListener('transitionend', () => {
            modal.remove();
        }, { once: true });
    }
};

export default modalService;
