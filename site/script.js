// Blockwright site: small, dependency-free behaviour.
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- Header shadow on scroll ---------- */
  var header = document.querySelector(".site-header");
  function onScroll() {
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile menu ---------- */
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  function setMenu(open) {
    toggle.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  }
  toggle.addEventListener("click", function () {
    setMenu(toggle.getAttribute("aria-expanded") !== "true");
  });
  nav.addEventListener("click", function (e) {
    if (e.target.closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setMenu(false);
      toggle.focus();
    }
  });
  window.matchMedia("(min-width: 761px)").addEventListener("change", function (mq) {
    if (mq.matches) setMenu(false);
  });

  /* ---------- Tabs (WAI-ARIA tabs pattern, automatic activation) ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !selected;
    });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { selectTab(tab, false); });
    tab.addEventListener("keydown", function (e) {
      var next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });
  // Hide the inactive panels (they stay visible when JS is off).
  tabs.forEach(function (t) {
    document.getElementById(t.getAttribute("aria-controls")).hidden = t.getAttribute("aria-selected") !== "true";
  });

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll(".faq-q").forEach(function (btn) {
    var panel = document.getElementById(btn.getAttribute("aria-controls"));
    panel.hidden = true;
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      panel.hidden = open;
    });
  });

  /* ---------- Lightbox ---------- */
  var dialog = document.getElementById("lightbox");
  var lbImg = document.getElementById("lightbox-img");
  var lbCap = document.getElementById("lightbox-caption");
  var shots = Array.prototype.slice.call(document.querySelectorAll("[data-lightbox]"));
  var current = 0;
  var opener = null;

  function visibleShots() {
    // Only step through screenshots the visitor can currently see (skip hidden tab panels).
    return shots.filter(function (s) { return !s.closest("[hidden]"); });
  }
  function show(index) {
    var list = visibleShots();
    current = (index + list.length) % list.length;
    var s = list[current];
    var img = s.querySelector("img");
    lbImg.src = s.getAttribute("data-lightbox");
    lbImg.alt = img ? img.alt : "";
    lbCap.textContent = s.getAttribute("data-caption") || "";
  }

  if (dialog && typeof dialog.showModal === "function") {
    shots.forEach(function (s) {
      s.addEventListener("click", function () {
        opener = s;
        show(visibleShots().indexOf(s));
        dialog.showModal();
        document.body.style.overflow = "hidden";
      });
    });
    dialog.addEventListener("click", function (e) {
      var action = e.target.closest("[data-lb]");
      if (action) {
        var a = action.getAttribute("data-lb");
        if (a === "close") dialog.close();
        else show(current + (a === "next" ? 1 : -1));
      } else if (e.target === dialog) {
        dialog.close(); // click on the dark area
      }
    });
    dialog.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); show(current + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); show(current - 1); }
    });
    dialog.addEventListener("close", function () {
      document.body.style.overflow = "";
      lbImg.removeAttribute("src");
      if (opener) opener.focus();
    });
  } else {
    // Very old browsers: open the image itself.
    shots.forEach(function (s) {
      s.addEventListener("click", function () { window.open(s.getAttribute("data-lightbox"), "_blank", "noopener"); });
    });
  }

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    revealEls.forEach(function (el) { io.observe(el); });
  }
})();
