function getMenuElements(menuId: string, triggerId: string) {
    const menu = document.getElementById(menuId);
    const trigger = document.getElementById(triggerId);
    if (!menu || !trigger) return null;
    return { menu, trigger };
}

export function toggleSettingsMenu(menuId = 'settingsMenu', triggerId = 'settingsBtn') {
    const elements = getMenuElements(menuId, triggerId);
    if (!elements) return false;

    const { menu, trigger } = elements;
    const isHidden = menu.hasAttribute('hidden');
    if (isHidden) {
        menu.removeAttribute('hidden');
    } else {
        menu.setAttribute('hidden', '');
    }
    trigger.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    return isHidden;
}

export function closeSettingsMenu(menuId = 'settingsMenu', triggerId = 'settingsBtn') {
    const elements = getMenuElements(menuId, triggerId);
    if (!elements) return;
    const { menu, trigger } = elements;
    menu.setAttribute('hidden', '');
    trigger.setAttribute('aria-expanded', 'false');
}

export function bindSettingsMenuDismiss(
    closeMenu: () => void,
    menuId = 'settingsMenu',
    triggerId = 'settingsBtn'
) {
    document.addEventListener('click', (event) => {
        const target = event.target as Node;
        const elements = getMenuElements(menuId, triggerId);
        if (!elements) return;
        const { menu, trigger } = elements;

        if (!menu.contains(target) && !trigger.contains(target)) {
            closeMenu();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeMenu();
        }
    });
}

