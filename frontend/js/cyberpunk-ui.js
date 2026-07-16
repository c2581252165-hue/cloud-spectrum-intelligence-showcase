/**
 * 赛博朋克 UI 增强模块
 * DataV风格装饰元素 + 动态效果
 */

(function() {
    'use strict';

    // ===== 配置 =====
    const CONFIG = {
        cornerSize: 16,
        primaryColor: '#00f3ff',
        secondaryColor: '#00b4d8',
        glowIntensity: 0.6,
        animationSpeed: 1
    };

    // ===== 工具函数 =====
    function createSVG(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, val] of Object.entries(attrs)) {
            el.setAttribute(key, val);
        }
        return el;
    }

    function createElement(tag, className, styles = {}) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        Object.assign(el.style, styles);
        return el;
    }

    // ===== 1. DataV装饰角 =====
    function addCornerDecorations(container) {
        if (!container || container.querySelector('.cp-corner-deco')) return;
        
        const corners = ['tl', 'tr', 'bl', 'br'];
        const positions = {
            tl: { top: '0', left: '0' },
            tr: { top: '0', right: '0' },
            bl: { bottom: '0', left: '0' },
            br: { bottom: '0', right: '0' }
        };
        
        corners.forEach(pos => {
            const corner = createElement('div', `cp-corner-deco cp-corner-${pos}`);
            Object.assign(corner.style, {
                position: 'absolute',
                width: `${CONFIG.cornerSize}px`,
                height: `${CONFIG.cornerSize}px`,
                pointerEvents: 'none',
                zIndex: '10',
                ...positions[pos]
            });
            
            // SVG角落图形
            const svg = createSVG('svg', {
                width: CONFIG.cornerSize,
                height: CONFIG.cornerSize,
                viewBox: `0 0 ${CONFIG.cornerSize} ${CONFIG.cornerSize}`
            });
            
            // 根据位置调整路径
            let path;
            switch(pos) {
                case 'tl':
                    path = `M0,${CONFIG.cornerSize} L0,0 L${CONFIG.cornerSize},0`;
                    break;
                case 'tr':
                    path = `M0,0 L${CONFIG.cornerSize},0 L${CONFIG.cornerSize},${CONFIG.cornerSize}`;
                    break;
                case 'bl':
                    path = `M0,0 L0,${CONFIG.cornerSize} L${CONFIG.cornerSize},${CONFIG.cornerSize}`;
                    break;
                case 'br':
                    path = `M0,${CONFIG.cornerSize} L${CONFIG.cornerSize},${CONFIG.cornerSize} L${CONFIG.cornerSize},0`;
                    break;
            }
            
            const pathEl = createSVG('path', {
                d: path,
                fill: 'none',
                stroke: CONFIG.primaryColor,
                'stroke-width': '2',
                filter: 'drop-shadow(0 0 3px ' + CONFIG.primaryColor + ')'
            });
            
            svg.appendChild(pathEl);
            corner.appendChild(svg);
            container.appendChild(corner);
        });
    }

    // ===== 2. 扫描线效果 =====
    function addScanlineEffect(container) {
        if (!container || container.querySelector('.cp-scan-effect')) return;
        
        const scanline = createElement('div', 'cp-scan-effect');
        Object.assign(scanline.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '2px',
            background: `linear-gradient(90deg, transparent, ${CONFIG.primaryColor}, transparent)`,
            boxShadow: `0 0 10px ${CONFIG.primaryColor}`,
            pointerEvents: 'none',
            zIndex: '15',
            opacity: '0.7'
        });
        
        // 动画
        let pos = 0;
        const height = container.offsetHeight || 400;
        
        function animate() {
            pos += 0.5 * CONFIG.animationSpeed;
            if (pos > height) {
                pos = -10;
                scanline.style.opacity = '0';
                setTimeout(() => { scanline.style.opacity = '0.7'; }, 200);
            }
            scanline.style.top = pos + 'px';
            requestAnimationFrame(animate);
        }
        
        container.appendChild(scanline);
        animate();
    }

    // ===== 3. 粒子背景 =====
    function createParticleBackground(container) {
        if (!container || container.querySelector('.cp-particles')) return;
        
        const canvas = createElement('canvas', 'cp-particles');
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '0',
            opacity: '0.4'
        });
        
        container.insertBefore(canvas, container.firstChild);
        
        const ctx = canvas.getContext('2d');
        let particles = [];
        
        function resize() {
            canvas.width = container.offsetWidth;
            canvas.height = container.offsetHeight;
        }
        
        function createParticle() {
            return {
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                size: Math.random() * 2 + 0.5,
                speedX: (Math.random() - 0.5) * 0.3,
                speedY: (Math.random() - 0.5) * 0.3,
                opacity: Math.random() * 0.5 + 0.2
            };
        }
        
        function init() {
            resize();
            particles = [];
            const count = Math.floor((canvas.width * canvas.height) / 8000);
            for (let i = 0; i < count; i++) {
                particles.push(createParticle());
            }
        }
        
        function animate() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            particles.forEach(p => {
                p.x += p.speedX;
                p.y += p.speedY;
                
                if (p.x < 0 || p.x > canvas.width) p.speedX *= -1;
                if (p.y < 0 || p.y > canvas.height) p.speedY *= -1;
                
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0, 243, 255, ${p.opacity})`;
                ctx.fill();
            });
            
            // 连接附近粒子
            particles.forEach((p1, i) => {
                particles.slice(i + 1).forEach(p2 => {
                    const dx = p1.x - p2.x;
                    const dy = p1.y - p2.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    
                    if (dist < 60) {
                        ctx.beginPath();
                        ctx.moveTo(p1.x, p1.y);
                        ctx.lineTo(p2.x, p2.y);
                        ctx.strokeStyle = `rgba(0, 243, 255, ${0.1 * (1 - dist / 60)})`;
                        ctx.stroke();
                    }
                });
            });
            
            requestAnimationFrame(animate);
        }
        
        init();
        animate();
        
        window.addEventListener('resize', init);
    }

    // ===== 4. 数字滚动效果 =====
    function animateNumber(element, targetValue, duration = 1000) {
        const startValue = parseFloat(element.textContent) || 0;
        const startTime = performance.now();
        const isFloat = targetValue % 1 !== 0;
        
        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // 缓动函数
            const easeOutQuart = 1 - Math.pow(1 - progress, 4);
            const currentValue = startValue + (targetValue - startValue) * easeOutQuart;
            
            element.textContent = isFloat ? currentValue.toFixed(4) : Math.round(currentValue);
            
            if (progress < 1) {
                requestAnimationFrame(update);
            }
        }
        
        requestAnimationFrame(update);
    }

    // ===== 5. 雷达脉冲效果 =====
    function createRadarPulse(container, x, y) {
        const radar = createElement('div', 'cp-radar-pulse');
        Object.assign(radar.style, {
            position: 'absolute',
            left: (x - 25) + 'px',
            top: (y - 25) + 'px',
            width: '50px',
            height: '50px',
            pointerEvents: 'none',
            zIndex: '20'
        });
        
        // 中心点
        const dot = createElement('div');
        Object.assign(dot.style, {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '8px',
            height: '8px',
            background: CONFIG.primaryColor,
            borderRadius: '50%',
            boxShadow: `0 0 10px ${CONFIG.primaryColor}`
        });
        radar.appendChild(dot);
        
        // 脉冲波
        for (let i = 0; i < 3; i++) {
            const wave = createElement('div');
            Object.assign(wave.style, {
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: '10px',
                height: '10px',
                border: `2px solid ${CONFIG.primaryColor}`,
                borderRadius: '50%',
                opacity: '0',
                animation: `radarWave 2s ease-out ${i * 0.5}s infinite`
            });
            radar.appendChild(wave);
        }
        
        container.appendChild(radar);
        
        // 3秒后移除
        setTimeout(() => radar.remove(), 3000);
    }

    // ===== 6. 全息投影线条效果 =====
    function addHologramLines(container) {
        if (!container || container.querySelector('.cp-holo-lines')) return;
        
        const overlay = createElement('div', 'cp-holo-lines');
        Object.assign(overlay.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '1',
            background: `repeating-linear-gradient(
                0deg,
                rgba(0, 243, 255, 0.03) 0px,
                rgba(0, 243, 255, 0.03) 1px,
                transparent 1px,
                transparent 3px
            )`
        });
        
        container.appendChild(overlay);
    }

    // ===== 7. 边框呼吸灯效果 =====
    function addBreathingBorder(element) {
        if (!element) return;
        
        element.style.animation = 'cpBreathingBorder 3s ease-in-out infinite';
    }

    // ===== 添加必要的动画CSS =====
    function injectAnimationStyles() {
        if (document.getElementById('cp-animation-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'cp-animation-styles';
        style.textContent = `
            @keyframes radarWave {
                0% {
                    width: 10px;
                    height: 10px;
                    opacity: 1;
                }
                100% {
                    width: 50px;
                    height: 50px;
                    opacity: 0;
                }
            }
            
            @keyframes cpBreathingBorder {
                0%, 100% {
                    box-shadow: 
                        0 0 5px rgba(0, 243, 255, 0.3),
                        inset 0 0 10px rgba(0, 243, 255, 0.05);
                }
                50% {
                    box-shadow: 
                        0 0 15px rgba(0, 243, 255, 0.5),
                        0 0 25px rgba(0, 180, 216, 0.3),
                        inset 0 0 20px rgba(0, 243, 255, 0.1);
                }
            }
            
            @keyframes cpTextGlow {
                0%, 100% {
                    text-shadow: 0 0 5px rgba(0, 243, 255, 0.5);
                }
                50% {
                    text-shadow: 0 0 15px rgba(0, 243, 255, 0.8), 0 0 25px rgba(0, 243, 255, 0.4);
                }
            }
            
            .cp-text-glow {
                animation: cpTextGlow 2s ease-in-out infinite;
            }
            
            .cp-fade-in {
                animation: cpFadeIn 0.5s ease-out forwards;
            }
            
            @keyframes cpFadeIn {
                from {
                    opacity: 0;
                    transform: translateY(10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
        `;
        document.head.appendChild(style);
    }

    // ===== 初始化 =====
    function init() {
        injectAnimationStyles();
        
        // 等待DOM加载完成
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyEffects);
        } else {
            applyEffects();
        }
    }

    function applyEffects() {
        // 侧边栏装饰
        const sidebar = document.querySelector('.sidebar-container');
        if (sidebar) {
            addCornerDecorations(sidebar);
            addHologramLines(sidebar);
        }
        
        // 左侧面板装饰
        const leftPanel = document.querySelector('.left-middle-panel');
        if (leftPanel) {
            addCornerDecorations(leftPanel);
            addBreathingBorder(leftPanel);
        }
        
        // 数据面板装饰
        const dataPanel = document.querySelector('.data-panel');
        if (dataPanel) {
            addCornerDecorations(dataPanel);
        }
        
        // 底部导航栏装饰
        const navbar = document.querySelector('.bottom-navbar');
        if (navbar) {
            addCornerDecorations(navbar);
        }
        
        // 子面板装饰
        document.querySelectorAll('.oilfield-panel').forEach(panel => {
            addCornerDecorations(panel);
        });

        console.log('[Cyberpunk UI] 装饰效果已应用');
    }

    // ===== 导出API =====
    window.CyberpunkUI = {
        addCornerDecorations,
        addScanlineEffect,
        createParticleBackground,
        animateNumber,
        createRadarPulse,
        addHologramLines,
        addBreathingBorder,
        refresh: applyEffects,
        CONFIG
    };

    // 启动
    init();

})();
