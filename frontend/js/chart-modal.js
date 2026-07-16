// 图表弹窗：打开/关闭、遮罩点击、Esc关闭
(function initChartModal() {
    const overlay = document.getElementById('overlay');
    const openBtn = document.getElementById('openChartsBtn');
    const closeBtn = document.getElementById('closeChartsBtn');

    // 防错：如果元素不存在则不执行
    if (!overlay || !openBtn || !closeBtn) return;

    // 1. 打开弹窗
    openBtn.addEventListener('click', () => {
        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');
    });

    // 2. 关闭弹窗（按钮）
    closeBtn.addEventListener('click', closeModal);

    // 3. 点击遮罩空白处关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    // 4. Esc键关闭
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('show')) {
            closeModal();
        }
    });

    // 关闭弹窗核心函数（复用）
    function closeModal() {
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
    }
})();