'use strict';
// How long to wait before asking again after a failed attempt: 1, 1, 2, 2, then 3 minutes at most.
// A late provider is asked again soon, and a failing one is never hammered.
module.exports = { retryDelay: n => Math.min(60000 * Math.ceil(n / 2), 180000) };
