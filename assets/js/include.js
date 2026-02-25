document.addEventListener("DOMContentLoaded", () => {
  const includes = Array.from(document.querySelectorAll("[data-include]"));
  const INCLUDE_VERSION = '2026-02-25-4';
  if (!includes.length) {
    // still dispatch to allow listeners
    document.dispatchEvent(new Event("includesLoaded"));
    return;
  }

  let remaining = includes.length;

  includes.forEach(el => {
    const url = new URL(el.dataset.include, window.location.origin);
    url.searchParams.set('v', INCLUDE_VERSION);
    fetch(url.toString(), { cache: 'no-store' })
      .then(res => res.text())
      .then(html => {
        el.innerHTML = html;

        // Execute any scripts contained in the included HTML.
        const scripts = Array.from(el.querySelectorAll('script'));
        scripts.forEach(oldScript => {
          const newScript = document.createElement('script');
          // copy attributes (type, src, async, etc.)
          Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));

          if (oldScript.src) {
            // external script
            newScript.src = oldScript.src;
            newScript.async = false; // preserve execution order
          } else {
            // inline script
            newScript.textContent = oldScript.textContent;
          }

          // replace the old script with the new one so it executes
          oldScript.parentNode.replaceChild(newScript, oldScript);
        });

        remaining -= 1;
        if (remaining === 0) {
          // All includes processed — dispatch once
          document.dispatchEvent(new Event("includesLoaded"));
        }
      })
      .catch(err => {
        console.error("Error loading component:", el.dataset.include, err);
        remaining -= 1;
        if (remaining === 0) document.dispatchEvent(new Event("includesLoaded"));
      });
  });
});
