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
