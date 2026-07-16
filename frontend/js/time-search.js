// 时间查询组件（支持手动输入+深灰样式）
(function initTimeSearch() {
    // 获取DOM元素
    const searchBtn = document.getElementById('timeSearchBtn');
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');

    // 防错处理
    if (!searchBtn || !startTimeInput || !endTimeInput) {
        console.warn('时间查询组件元素未找到');
        return;
    }

    // 初始化：设置占位符和默认日期
    function initTimeInputs() {
        // 强制占位符为灰色（兼容不支持placeholder-color的浏览器）
        startTimeInput.placeholder = 'YYYY-MM-DD';
        endTimeInput.placeholder = 'YYYY-MM-DD';
        startTimeInput.style.color = '#c0c5ce';
        endTimeInput.style.color = '#c0c5ce';

        // 设置默认日期（最近7天）
        const today = new Date();
        const lastWeek = new Date(today);
        lastWeek.setDate(today.getDate() - 7);
        startTimeInput.value = formatDate(lastWeek);
        endTimeInput.value = formatDate(today);
    }

    // 格式化日期为 YYYY-MM-DD
    function formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // 验证手动输入的日期格式
    function validateDate(input) {
        const value = input.value.trim();
        // 正则匹配 YYYY-MM-DD（简单验证）
        const regex = /^\d{4}-\d{2}-\d{2}$/;
        if (!regex.test(value)) {
            return { valid: false, message: '格式应为 YYYY-MM-DD' };
        }

        // 验证月份和日期有效性
        const [year, month, day] = value.split('-').map(Number);
        if (month < 1 || month > 12) {
            return { valid: false, message: '月份应为 01-12' };
        }
        if (day < 1 || day > 31) {
            return { valid: false, message: '日期应为 01-31' };
        }
        if ((month === 4 || month === 6 || month === 9 || month === 11) && day > 30) {
            return { valid: false, message: '该月最多30天' };
        }
        if (month === 2) {
            const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
            if (day > (isLeap ? 29 : 28)) {
                return { valid: false, message: `2月${isLeap ? '最多29天' : '最多28天'}` };
            }
        }

        return { valid: true, value };
    }

    // 验证时间范围
    function validateTimeRange() {
        const startValid = validateDate(startTimeInput);
        if (!startValid.valid) {
            return { valid: false, message: `起始时间：${startValid.message}` };
        }

        const endValid = validateDate(endTimeInput);
        if (!endValid.valid) {
            return { valid: false, message: `终止时间：${endValid.message}` };
        }

        const startDate = new Date(startValid.value);
        const endDate = new Date(endValid.value);
        if (startDate > endDate) {
            return { valid: false, message: '起始时间不能晚于终止时间' };
        }

        return { valid: true, start: startValid.value, end: endValid.value };
    }

    // 输入时自动格式化（可选：输入数字后自动补横线）
    function autoFormatInput(input) {
        input.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, ''); // 只保留数字
            if (value.length > 4) {
                value = value.slice(0, 4) + '-' + value.slice(4);
            }
            if (value.length > 7) {
                value = value.slice(0, 7) + '-' + value.slice(7, 11);
            }
            e.target.value = value;
        });
    }

    // 绑定事件
    function bindEvents() {
        // 自动格式化输入
        autoFormatInput(startTimeInput);
        autoFormatInput(endTimeInput);

        // 输入框失焦时验证
        [startTimeInput, endTimeInput].forEach(input => {
            input.addEventListener('blur', () => {
                const result = validateDate(input);
                if (!result.valid) {
                    showTooltip(result.message);
                }
            });
        });

        // 查询按钮点击事件
        searchBtn.addEventListener('click', () => {
            const result = validateTimeRange();
            if (!result.valid) {
                showTooltip(result.message);
                return;
            }

            // 查询成功逻辑
            showTooltip(`已查询 ${result.start} 至 ${result.end} 的数据`);
            console.log('查询时间范围：', result.start, '至', result.end);
            // 此处可添加实际查询逻辑（如筛选数据、更新地图等）
        });
    }

    // 初始化
    initTimeInputs();
    bindEvents();
})();