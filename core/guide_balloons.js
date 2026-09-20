// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa

// 操作部の位置と電源表示に合わせて、初回の案内を出す。
export function initGuideBalloons() {
    const POWER_KEY = 'webm7_guide_power_dismissed';
    const TOUR_KEY = 'webm7_guide_completed';
    function readFlag(storage, key) {
        try { return window[storage].getItem(key) === '1'; }
        catch { return false; }
    }
    function saveFlag(storage, key) {
        try { window[storage].setItem(key, '1'); }
        catch { /* 保存できないときも、このページでは閉じた状態を保つ。 */ }
    }
    let powerDismissed = readFlag('sessionStorage', POWER_KEY);
    let tourCompleted = readFlag('localStorage', TOUR_KEY);
    let step = 0;
    let activeKind = null;
    let frame = 0;
    const steps = [
        {
            selector: '#hwPanel .hw-bay[data-drive]:not(.loaded), #hwPanel .hw-vbay[data-drive]:not(.loaded)',
            text: 'ドライブをクリックするとディスクを選べます',
        },
        {
            selector: '#hwDipBoot, #hwLipBoot, #hwLipBootPush',
            text: '起動モード（BASIC / DOS）はここで切り替えます',
        },
        {
            selector: '#scaleToggle',
            text: '表示の大きさとフルスクリーンはここで切り替えます',
        },
    ];
    const balloon = document.createElement('div');
    balloon.className = 'guide-balloon';
    balloon.hidden = true;
    balloon.setAttribute('role', 'region');
    balloon.setAttribute('aria-label', '操作の案内');
    const message = document.createElement('span');
    message.setAttribute('role', 'status');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'guide-balloon-close';
    close.textContent = '×';
    balloon.append(message, close);
    document.body.append(balloon);

    function firstVisible(selector) {
        return Array.from(document.querySelectorAll(selector)).find(el => {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        });
    }

    function position(target) {
        const rect = target.getBoundingClientRect();
        const viewport = window.visualViewport;
        const leftEdge = viewport?.offsetLeft || 0;
        const topEdge = viewport?.offsetTop || 0;
        const width = viewport?.width || document.documentElement.clientWidth;
        const height = viewport?.height || document.documentElement.clientHeight;
        const rightEdge = leftEdge + width;
        const bottomEdge = topEdge + height;
        // 画面の外にある操作部は、スクロールで戻ってくるまで案内を隠す。
        if (rect.bottom <= topEdge || rect.top >= bottomEdge || rect.right <= leftEdge || rect.left >= rightEdge) {
            balloon.hidden = true;
            return;
        }
        const margin = 8;
        const gap = 12;
        balloon.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
        balloon.hidden = false;
        const box = balloon.getBoundingClientRect();
        const center = Math.max(leftEdge, Math.min(rightEdge, (rect.left + rect.right) / 2));
        const left = Math.max(leftEdge + margin, Math.min(center - box.width / 2, rightEdge - box.width - margin));
        const above = rect.top - gap - box.height;
        const below = rect.bottom + gap;
        const useBelow = above < topEdge + margin &&
            (below + box.height <= bottomEdge - margin || rect.top - topEdge < bottomEdge - rect.bottom);
        const top = Math.max(topEdge + margin, Math.min(useBelow ? below : above, bottomEdge - box.height - margin));
        balloon.dataset.side = useBelow ? 'below' : 'above';
        balloon.style.left = `${left}px`;
        balloon.style.top = `${top}px`;
        balloon.style.setProperty('--guide-arrow-x', `${Math.max(14, Math.min(box.width - 14, center - left))}px`);
    }

    function update() {
        frame = 0;
        let target;
        let text;
        activeKind = null;
        if (!document.body.classList.contains('hw-power-on')) {
            if (!powerDismissed) {
                target = firstVisible('#hwTowerPower, #hwBarPowerLeft, #hwBarPowerRight');
                text = 'ここを押すと電源が入ります';
                activeKind = 'power';
            }
        } else if (!tourCompleted) {
            // 表示されない項目は飛ばす。電源を切った間は進めない。
            while (step < steps.length) {
                target = firstVisible(steps[step].selector);
                if (target) break;
                step++;
            }
            if (step === steps.length) {
                tourCompleted = true;
                saveFlag('localStorage', TOUR_KEY);
            } else {
                text = steps[step].text;
                activeKind = 'tour';
            }
        }
        if (!target) {
            balloon.hidden = true;
            return;
        }
        if (message.textContent !== text) message.textContent = text;
        close.setAttribute('aria-label', activeKind === 'power' ? '電源の案内を閉じる' : 'この案内を閉じて次へ');
        position(target);
    }

    function schedule() {
        if (!frame) frame = requestAnimationFrame(update);
    }
    close.addEventListener('click', () => {
        if (activeKind === 'power') {
            powerDismissed = true;
            saveFlag('sessionStorage', POWER_KEY);
        } else if (activeKind === 'tour') {
            step++;
        }
        balloon.hidden = true;
        schedule();
    });
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // ディスクを入れたベイを案内し続けないよう、空き状態も監視する。
    const bays = new MutationObserver(schedule);
    document.querySelectorAll('#hwPanel .hw-bay[data-drive], #hwPanel .hw-vbay[data-drive]').forEach(el => {
        bays.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    const layout = new ResizeObserver(schedule);
    for (const el of document.querySelectorAll('body, #hwPanel, #scaleToggle')) layout.observe(el);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    window.addEventListener('storage', event => {
        if (event.key === TOUR_KEY && event.newValue === '1') {
            tourCompleted = true;
            schedule();
        }
    });
    schedule();
}
