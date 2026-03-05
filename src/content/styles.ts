export const PINPINTO_CONTENT_STYLE_ID = 'pinvault-styles';

export const PINPINTO_CONTENT_STYLE_TEXT = `
            .pinvault-overlay {
                background: rgba(0, 0, 0, 0.8);
                border-radius: 50%;
                width: 28px;
                height: 28px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.2s ease;
                border: 2px solid transparent;
                user-select: none;
            }

            .pinvault-overlay-controls {
                position: absolute;
                inset: 0;
                z-index: 2147483645;
                pointer-events: none;
            }

            .pinvault-overlay-group {
                position: absolute;
                top: 8px;
                right: 8px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                align-items: center;
                pointer-events: auto;
            }

            .pinvault-overlay:hover {
                background: rgba(0, 0, 0, 0.9);
                transform: scale(1.1);
            }

            .pinvault-overlay.selected {
                background: rgba(187, 247, 208, 0.95);
                border-color: #166534;
                color: #14532d;
            }

            .pinvault-overlay.success {
                background: rgba(40, 167, 69, 0.9);
                border-color: rgba(255, 255, 255, 0.8);
            }

            .pinvault-overlay.error {
                background: rgba(220, 53, 69, 0.9);
                border-color: rgba(255, 255, 255, 0.8);
            }

            .pinvault-checkbox {
                color: white;
                font-size: 14px;
                font-weight: bold;
                pointer-events: none;
            }

            .pinvault-single-download-btn {
                position: absolute;
                left: 8px;
                bottom: 8px;
                min-width: 96px;
                height: 32px;
                padding: 0 10px;
                border: 1px solid #166534;
                border-radius: 10px;
                background: linear-gradient(180deg, #dcfce7 0%, #bbf7d0 100%);
                color: #14532d;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                cursor: pointer;
                transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
                box-shadow: 0 2px 10px rgba(20, 83, 45, 0.24);
                font-size: 12px;
                font-weight: 600;
                letter-spacing: 0.01em;
                pointer-events: auto;
                z-index: 2147483646;
                touch-action: manipulation;
            }

            .pinvault-single-download-btn:hover {
                background: linear-gradient(180deg, #d1fae5 0%, #a7f3d0 100%);
                box-shadow: 0 3px 14px rgba(20, 83, 45, 0.32);
                transform: translateY(-1px);
            }

            .pinvault-single-download-btn:active {
                transform: translateY(0);
                box-shadow: 0 2px 8px rgba(20, 83, 45, 0.25);
            }

            .pinvault-single-download-btn.success {
                background: rgba(16, 185, 129, 0.95);
                border-color: #064e3b;
                color: #ecfdf5;
            }

            .pinvault-single-download-btn.error {
                background: rgba(220, 53, 69, 0.95);
                border-color: rgba(255, 255, 255, 0.85);
                color: #fff;
            }

            .pinvault-single-download-btn svg {
                flex-shrink: 0;
            }

            .pinvault-single-download-btn-label {
                line-height: 1;
            }

            .pinvault-image-container {
                position: relative;
            }

            .pinvault-image-container.pinvault-selected {
                background: rgba(187, 247, 208, 0.35);
                box-shadow: inset 0 0 0 3px #166534;
            }

            .pinvault-loading {
                position: fixed;
                top: 20px;
                right: 20px;
                background: rgba(0, 123, 255, 0.9);
                color: white;
                padding: 12px 20px;
                border-radius: 25px;
                font-size: 14px;
                font-weight: 500;
                z-index: 10000;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                transition: all 0.3s ease;
            }

            .pinvault-loading.hidden {
                opacity: 0;
                transform: translateY(-20px);
            }

            .pinvault-scroll-indicator {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: rgba(255, 193, 7, 0.9);
                color: #212529;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 500;
                z-index: 10000;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0% { opacity: 0.8; }
                50% { opacity: 1; }
                100% { opacity: 0.8; }
            }
`;
