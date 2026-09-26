// "/" is the Unison landing page; "/app" is the product. Each loads its own bundle and global CSS.
if (/^\/app(\/|$)/.test(location.pathname)) void import("./main");
else void import("./landing/Landing");
