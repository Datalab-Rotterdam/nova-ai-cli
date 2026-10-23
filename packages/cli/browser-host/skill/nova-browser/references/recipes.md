# Recipes

Examples use the script form (`nova-browser …`, meaning `<skill root>/scripts/nova-browser`).
With MCP tools, call the same tool with the same arguments.

## Open a site in a new tab and read it

```sh
nova-browser tabs_create url=https://www.rotterdam.nl
nova-browser get_page_text tabId=<id from tabs_create>
```

`tabs_create` waits for the page to load. Use `get_page_text` for reading and `read_page` when you
need to act.

## Search a site

```sh
nova-browser find tabId=<id> query="search box"
nova-browser computer tabId=<id> action=left_click ref=<ref>
nova-browser computer tabId=<id> action=type text="opening hours Markthal"
nova-browser computer tabId=<id> action=key text=Enter
nova-browser get_page_text tabId=<id>
```

`type` with a newline in the text also presses Enter.

## Fill in a form

1. `read_page tabId=<id>` and map each field to its ref.
2. Text fields, selects, checkboxes and radios: `form_input ref=<ref> value=<value>`
   (`value=true` checks a checkbox; selects take the option text).
3. Fields that react to typing (autocomplete, masked inputs): click the field, then
   `computer action=type`.
4. Read the page again and check every value before submitting. **Ask the user before submitting**
   anything that sends data to someone (orders, applications, messages).

## Sign-in walls, CAPTCHAs and two-factor codes

Do not type credentials or codes. Tell the user what is needed ("Please sign in to … in the Nova
tab, then tell me to continue"), wait for their reply, then `read_page` again.

## Test a local web app

```sh
nova-browser tabs_create url=http://localhost:5173
nova-browser computer tabId=<id> action=screenshot
nova-browser read_console_messages tabId=<id> only_errors=true
nova-browser read_network_requests tabId=<id> url_pattern=/api/
```

- Console and network logs are recorded from the moment Nova attaches to the tab. To capture
  start-up errors, `navigate tabId=<id> url=<same url>` once and read the logs after.
- After changing code, reload with `navigate` and check again.
- Use `resize_window` to check responsive layouts (e.g. `width=390 height=844`).

## Click by coordinates

When an element has no ref (canvas, map, custom widget):

1. `computer action=screenshot` and find the target in the image.
2. `computer action=left_click 'coordinate=[x,y]'` using pixels of that screenshot.
3. Small text? `computer action=zoom 'region=[x0,y0,x1,y1]'` gives a close-up; click coordinates
   still refer to the full screenshot.

## Long pages

- `computer action=scroll scroll_direction=down scroll_amount=5`, or
  `computer action=scroll_to ref=<ref>` to bring an element into view.
- `read_page` marks elements outside the viewport with `(offscreen)`; clicking a ref scrolls to it.
- `read_page ref=<ref of a section>` reads only that part when the full page is too long.

## When things go wrong

| Message | What to do |
|---|---|
| `… is covered by …` | A popup or cookie banner is in the way: close or accept it (ask the user if it is a choice they should make), then retry. |
| `… no longer exists on the page` | The page changed. Call `read_page` or `find` again for fresh refs. |
| `… is not in the Nova tab group` | Call `tabs_context` and use one of its tab ids, or `tabs_create`. |
| `Nova cannot control this page` | Browser pages (`chrome://`, the Web Store, PDFs) are off limits; navigate to a website. |
| `The user did not allow <app> to use the browser` | The user said no to your app. Stop and ask them; they can allow it in the Nova AI extension's settings. |
| `The user did not allow Nova on …` / `pressed Stop` | Stop and ask the user. |
| `not connected` | Ask the user to open the browser with the extension. |
