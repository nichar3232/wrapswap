// "/" is the Unison landing page, "/app" the product. "/developers" was retired: old links land on the technical slide.
// Each loads its own bundle and global CSS.
if (/^\/app(\/|$)/.test(location.pathname)) void import("./main");
else if (/^\/developers\/?$/.test(location.pathname)) location.replace("/#tech");
else void import("./landing/Landing");
