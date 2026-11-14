export type ContextMenuFeedbackKind = 'success' | 'error';

export function showContextMenuFeedback(kind: unknown, message: unknown): void {
    if (typeof message !== 'string' || !message) return;
    const previous = document.querySelector('.pinvault-context-menu-feedback');
    previous?.remove();

    const feedback = document.createElement('div');
    feedback.className = `pinvault-context-menu-feedback ${kind === 'error' ? 'error' : 'success'}`;
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.textContent = message;
    document.body.appendChild(feedback);
    window.setTimeout(() => feedback.remove(), 3200);
}
