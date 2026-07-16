// 统一的页面访问鉴权守卫
(function() {
    const user = localStorage.getItem('sky_user');
    if (!user) {
        window.location.replace('/login.html');
    }
})();
