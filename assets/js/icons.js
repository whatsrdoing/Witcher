/* Offline inline SVG icon set. Add an icon by adding one entry here and
   referencing its key from dashboards.json ("icon": "myKey"). */
(function (w) {
  'use strict';
  var P = {
    cart:      '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.55L21 8H6"/>',
    pill:      '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M8.2 8.2l7.6 7.6"/>',
    boxes:     '<path d="M3 8.5 12 4l9 4.5-9 4.5z"/><path d="M3 8.5v7L12 20l9-4.5v-7"/><path d="M12 13v7"/>',
    truck:     '<path d="M2 6.5h11v10H2z"/><path d="M13 10h4l4 3.5v3h-8z"/><circle cx="6.5" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/>',
    shield:    '<path d="M12 3l7.5 3v5.4c0 4.5-3 8.4-7.5 9.6-4.5-1.2-7.5-5.1-7.5-9.6V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    clipboard: '<path d="M9 4h6v3H9z"/><path d="M15 5.5h2.5A1.5 1.5 0 0 1 19 7v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9"/><path d="M8.5 12h7M8.5 16h4.5"/>',
    chart:     '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="11" width="3" height="6" rx=".8"/><rect x="13" y="7" width="3" height="10" rx=".8"/>',
    trending:  '<path d="M3 17.5 9.5 11l4 4L21 7.5"/><path d="M15.5 7.5H21v5.5"/>',
    users:     '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.2"/><path d="M17.5 14.4A6.5 6.5 0 0 1 21.5 20"/>',
    handshake: '<path d="m11 7-2.6-1.2a2 2 0 0 0-1.9.1L2.5 8.5v6l3.5 3 2.4-2.1"/><path d="m13 7 2.6-1.2a2 2 0 0 1 1.9.1l4 2.6v6l-3.5 3-5-4.2"/><path d="m8.4 15.4 3 2.6"/>',
    flask:     '<path d="M9.5 3v6L4.7 17.4A2 2 0 0 0 6.4 20.5h11.2a2 2 0 0 0 1.7-3.1L14.5 9V3"/><path d="M8.5 3h7"/><path d="M7.3 14h9.4"/>',
    grid:      '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    file:      '<path d="M13.5 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M13.5 3v5h5"/>',
    folder:    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4L10.5 7h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
    search:    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>',
    home:      '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.6V20h13V9.6"/><path d="M9.8 20v-5.6h4.4V20"/>',
    back:      '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
    close:     '<path d="m6 6 12 12M18 6 6 18"/>',
    plus:      '<path d="M12 5v14M5 12h14"/>',
    eye:       '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeoff:    '<path d="M4 4l16 16"/><path d="M9.5 6.1A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4"/><path d="M6.4 8.3A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.6-.7"/><path d="M9.7 10.2a2.8 2.8 0 0 0 3.9 3.9"/>',
    grip:      '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
    reset:     '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V10H9"/>',
    refresh:   '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10H15"/>',
    external:  '<path d="M14 4h6v6"/><path d="m20 4-8.5 8.5"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    expand:    '<path d="M4 9V4.5h5"/><path d="M20 9V4.5h-5"/><path d="M4 15v4.5h5"/><path d="M20 15v4.5h-5"/>',
    download:  '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
    pencil:    '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 6.5 3 3"/>',
    trash:     '<path d="M4.5 7h15"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2A1.5 1.5 0 0 0 16.6 19L17.5 7"/>',
    upload:    '<path d="M12 19V8"/><path d="m7.5 12 4.5-4.5 4.5 4.5"/><path d="M4.5 4.5h15"/>',
    layers:    '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3.5 12.5 8.5 4.7 8.5-4.7"/>',
    moon:      '<path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5z"/>',
    sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
    lock:      '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    bolt:      '<path d="M13 3 5.5 13.5H11L10 21l8-11h-5.5z"/>',
    info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>',
    check:     '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16 9.6"/>',
    warn:      '<path d="M12 4 2.5 20.5h19z"/><path d="M12 10v4.5M12 17.6v.4"/>',
    inbox:     '<path d="M3.5 13.5h4l1.5 3h6l1.5-3h4"/><path d="M5.6 5.2 3.5 13.5v4A1.5 1.5 0 0 0 5 19h14a1.5 1.5 0 0 0 1.5-1.5v-4l-2.1-8.3A1.5 1.5 0 0 0 16.9 4H7.1a1.5 1.5 0 0 0-1.5 1.2z"/>',
    clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    bell:      '<path d="M6 10a6 6 0 0 1 12 0c0 4.5 1.5 6 1.5 6h-15S6 14.5 6 10z"/><path d="M10.3 19.5a1.9 1.9 0 0 0 3.4 0"/>'
  };
  function svg(name, cls) {
    var d = P[name] || P.grid;
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
  }
  w.Icons = { svg: svg, has: function (n) { return !!P[n]; }, set: P };
})(window);
