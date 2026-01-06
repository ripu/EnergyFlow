(function () {
    const originalError = console.error;
    console.error = function (...args) {
        fetch('/log', {
            method: 'POST',
            body: args.join(' ')
        }).catch(() => { });
        originalError.apply(console, args);
    };
    window.onerror = function (msg, url, line) {
        fetch('/log', {
            method: 'POST',
            body: `Uncaught Error: ${msg} @ ${url}:${line}`
        }).catch(() => { });
    };
})();
