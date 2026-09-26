// "/" is the Unison landing page, "/developers" the architecture and contracts, "/app" the product.
// Each loads its own bundle and global CSS.
if (/^\/app(\/|$)/.test(location.pathname)) void import("./main");
else if (/^\/developers\/?$/.test(location.pathname)) void import("./landing/Developers");
else void import("./landing/Landing");
