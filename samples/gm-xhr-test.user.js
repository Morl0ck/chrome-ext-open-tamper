// ==UserScript==
// @name         GM_xmlhttpRequest Test
// @namespace    https://opentamper.example
// @version      1.0
// @description  Test script demonstrating GM_xmlhttpRequest to bypass CORS
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    console.log('[GM_xmlhttpRequest Test] Script loaded');

    // Test 1: Simple GET request to a cross-origin API
    GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://httpbin.org/get?test=opentamper',
        onload: function(response) {
            console.log('[GM_xmlhttpRequest Test] GET request successful!');
            console.log('Status:', response.status);
            console.log('Response:', response.responseText.substring(0, 200) + '...');
        },
        onerror: function(error) {
            console.error('[GM_xmlhttpRequest Test] GET request failed:', error);
        }
    });

    // Test 2: POST request with JSON body
    GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://httpbin.org/post',
        headers: {
            'Content-Type': 'application/json'
        },
        data: JSON.stringify({ message: 'Hello from Open Tamper!' }),
        onload: function(response) {
            console.log('[GM_xmlhttpRequest Test] POST request successful!');
            console.log('Status:', response.status);
            try {
                const data = JSON.parse(response.responseText);
                console.log('Echoed data:', data.json);
            } catch (e) {
                console.log('Response:', response.responseText.substring(0, 200));
            }
        },
        onerror: function(error) {
            console.error('[GM_xmlhttpRequest Test] POST request failed:', error);
        }
    });

    // Test 3: Request with timeout
    GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://httpbin.org/delay/5',  // 5 second delay
        timeout: 2000,  // 2 second timeout
        onload: function(response) {
            console.log('[GM_xmlhttpRequest Test] Timeout test - request completed (unexpected)');
        },
        ontimeout: function() {
            console.log('[GM_xmlhttpRequest Test] Timeout test - correctly timed out after 2 seconds');
        },
        onerror: function(error) {
            console.log('[GM_xmlhttpRequest Test] Timeout test - error:', error);
        }
    });

    // Test 4: JSON response type
    GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://httpbin.org/json',
        responseType: 'json',
        onload: function(response) {
            console.log('[GM_xmlhttpRequest Test] JSON response test successful!');
            console.log('Parsed response:', response.response);
        },
        onerror: function(error) {
            console.error('[GM_xmlhttpRequest Test] JSON response test failed:', error);
        }
    });

    console.log('[GM_xmlhttpRequest Test] All test requests initiated');
})();
