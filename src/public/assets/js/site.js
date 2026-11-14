/* Astreth — small enhancements: mobile menu, hero video, and in-page form sending. */
(function () {
  'use strict';

  // ----- Mobile menu -----
  var toggle = document.querySelector('[data-menu-toggle]');
  var menu = document.querySelector('[data-menu]');
  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('menu-open', open);
      if (open) {
        var first = menu.querySelector('a');
        if (first) first.focus();
      }
    };
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && document.body.classList.contains('menu-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    var wide = window.matchMedia('(min-width: 900px)');
    var onWide = function () { if (wide.matches) setOpen(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
  }

  // ----- Hero video: don't autoplay for people who prefer reduced motion -----
  var video = document.querySelector('[data-hero-video]');
  if (video && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    video.removeAttribute('autoplay');
    video.pause();
  }

  // ----- Forms: send to the form service without leaving the page -----
  var forms = document.querySelectorAll('form[data-ajax-form]');
  Array.prototype.forEach.call(forms, function (form) {
    var status = form.querySelector('.form__status');
    var button = form.querySelector('[type="submit"]');
    var isNewsletter = form.classList.contains('newsletter__form');

    function setStatus(text, kind) {
      if (!status) return;
      status.textContent = text;
      status.className = 'form__status' + (kind ? ' ' + kind : '');
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new FormData(form);

      // Send the checkbox choices as one readable line.
      var interests = data.getAll('interested_in');
      if (interests.length) {
        data.delete('interested_in');
        data.append('interested_in', interests.join(', '));
      }
      // Put the visitor's subject in the notification email's subject line.
      var subject = data.get('subject');
      if (subject && data.has('_subject')) data.set('_subject', 'Astreth website: ' + subject);

      if (button) button.disabled = true;
      setStatus('Sending…', '');

      fetch(form.action, { method: 'POST', body: data, headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (response.ok) {
            form.reset();
            setStatus(isNewsletter ? 'Thanks for signing up!' : 'Thank you! Your message has been sent.', 'is-success');
            return;
          }
          return response.json().catch(function () { return {}; }).then(function (body) {
            var detail = body && body.errors ? body.errors.map(function (e) { return e.message; }).join(', ') : '';
            throw new Error(detail || 'The form service returned an error.');
          });
        })
        .catch(function (error) {
          setStatus('Sorry, that didn’t go through (' + error.message + '). Please try again in a moment.', 'is-error');
        })
        .finally(function () {
          if (button) button.disabled = false;
        });
    });
  });
})();
