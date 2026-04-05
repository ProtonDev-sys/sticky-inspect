# Sticky Inspect

Chromium extension for "perma inspect element" style changes on dynamic pages.

Instead of saving the whole DOM, it saves targeted rules for specific elements and reapplies them whenever those elements appear again after refresh.

## What it can save

- Set an element's text
- Set an input or textarea value
- Set an element's inner HTML
- Set a specific attribute
- Remove an element

## How to use it

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose `Load unpacked`.
4. Select this folder.
5. Open the page you want to modify.
6. Click the extension icon and press `Pick Element`.
7. Hover the page and click the element you want to persist.
8. Choose the action, enter the saved value if needed, and press `Save Rule`.
9. Refresh the page.

The extension reapplies saved rules automatically and also watches for later DOM rerenders on dynamic pages.

## Notes

- Rules are stored per site scope such as `roblox.com`, not per individual page URL.
- A rule saved on `roblox.com/home` will also be available on other `roblox.com` pages and matching subdomains that resolve to the same base domain scope.
- Selectors are generated automatically from the clicked element.
- The content script runs at `document_start` and briefly cloaks the page while saved rules are applied so the page is more likely to appear with the saved values from the start.
- If a site rebuilds its structure heavily between loads, you may need to recreate the rule so it targets the new selector.
- `Clear Saved Rules` removes all saved rules for the current site scope.
