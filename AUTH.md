I need to implement proper authentication and user management, following the same patterns and file structure as another one of my apps

PROJECT SETUP:
- Build tool: Vite (you know this)
- JavaScript: Vanilla JS (ES6 modular structure we are using now)
- Templating: Handlebars (.hbs files)
- Styling: CSS (not SCSS, but proper nested pattern)
- Backend: AWS API Gateway + Lambda, DynamoDB for storing user login credentials (email/username and password) and info

FILE STRUCTURE TO FOLLOW:
- need a login component with js hbs and css files
- need users component and service?
- need to utilize renders component and create service?
- need cookies, users, aws services
- properly initialize layout and user and login main app page etc

COMPONENT STRUCTURE PATTERN:
Each component should follow this exact structure from MasonDash:

```javascript
// ComponentName.js
import template from "./componentname.hbs";
import "./componentname.css";
import service from "../../services/someService";

const componentName = {
    // Initialize the component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },
    
    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector(".selector-for-component");
        let html = template({ main: true });
        this.element.innerHTML = html;
    },
    
    // Load data from services/API
    async _loadData() {
        this.data = await service.get();
    },
    
    // Bind event listeners
    _bindListeners() {
        this.element.addEventListener("click", (e) => {
            // handle events
        });
    }
};

export default componentName;
HANDLEBARS TEMPLATE PATTERN:


{{#if main}}
    <!-- Main component display content -->
    <div class="component-body">
        <!-- list items, forms, etc -->
    </div>
{{/if}}

{{#if dialog}}
    <!-- Modal dialog template for detail views -->
    <dialog id="component-dialog">
        <div class="dialog-header"></div>
        <div class="dialog-body"></div>
        <div class="dialog-footer">
            <button>Close</button>
        </div>
    </dialog>
{{/if}}

{{#if dialogcontent}}
    <!-- Dynamic content injected into dialog -->
    <div class="content">
        {{#each this}}
            <!-- display data -->
        {{/each}}
    </div>
{{/if}}

css structure should look like this in correspondence to hbs
.__login-header {
    position: absolute;
    top: 2rem;
    left: 2rem;
    z-index: 10;
    
    .__login-branding {
      .__brand-name {
        font-size: 2rem;
        font-weight: 700;
        color: var(--text-color);
        letter-spacing: -0.02em;
      }
    }
  }

<div class="__login-container">
    <div class="__login-header">
        <div class="__login-branding">
            <span class="__brand-name">WovenAI</span>
        </div>
    </div>
    <div class="__login-footer">
        <div class="__steampunk-credit">
            <img src="./steampunk.jpg" class="__steampunk-logo" alt="Steampunk logo" />
            <span>Steampunk Inc.</span>
        </div>
    </div>
    <div class="__login-main">
        <div class="__login-body">
            <img src="./logo.png" class="logo" alt="Woven logo" />
            <div class="__login-title">Your Favorite MCP Client</div>
            <input id="email" class="__login-input" placeholder="Enter your email address" type="email" />
            <button id="submit">
                Sign In<span class="punk-icon">login</span>
            </button>
        </div>
    </div>
</div>


ENTRY POINT FLOW (index.js):

Detect if on login page or dashboard
If dashboard: check for "builting-user" cookie
If cookie exists: initialize app (layout + user + other components)
If no cookie: redirect to login.html
If login page: initialize login component
SERVICE LAYER IMPLEMENTATION:

aws.js - Route to correct API endpoint

localhost → /api (webpack proxy)
production → custom domain API Gateway URL
cookieService.js - Cookie operations

set(cname, cvalue, minutes)
get(cname)
delete(cname) [optional]
authenticateService.js [NEW]

Call POST /login endpoint with credentials
Validate response from Lambda/DynamoDB
Return user object on success, throw error on failure
usersService.js - Fetch user data

Get "builting-user" cookie value
Call backend API with that credential
Return user data (email, name, preferences, etc)
LOGIN FLOW:

User enters credentials on login page
login.js calls authenticateService.login(credentials)
authenticateService makes API call to Lambda
Lambda validates against DynamoDB
If valid: return user object → set "builting-user" cookie → redirect to index.html
If invalid: show error message
DASHBOARD FLOW:

index.js checks "builting-user" cookie exists
Initializes layout.js (renders main dashboard HTML)
Initializes user.js (fetches user info, displays name in header)
Initializes users.js (fetches list of users, renders in sidebar/section)
Initializes renders.js (fetches renders data, creates interactive list with modals)
RENDERS COMPONENT SPECIFICS (similar to courses):

_loadData: Fetch all renders from backend, filter by current user's permissions
_render: Create clickable cards/list items for each render
_bindListeners: Click handler → populate modal with render details → show modal dialog
Each render item should have: id, name, description, thumbnail, created date, etc.
VITE CONFIGURATION:

Configure Handlebars loader for .hbs file imports
Set up alias for "services" and "components" imports
Configure CSS processing
Set up proxy for /api calls to localhost backend
Build output to dist/
IMPORTANT CONVENTIONS (matching MasonDash):

Use document.querySelector() for DOM manipulation
Use innerHTML for rendering templates
Use insertAdjacentHTML() for appending to DOM
Async/await for all service calls
Event delegation where appropriate
$ prefix for DOM element variables (e.g., $element = document.querySelector(...))
Private methods prefixed with underscore (_methodName)
Classes with kebab-case names in HTML (login-button, form-title, etc)
Handlebars conditionals for different template sections (main, dialog, dialogcontent)
CODE ORGANIZATION:

Each component is self-contained in its own folder
Related logic (JS, template, styles) stays together
Services are shared utilities in separate files
No component imports other components directly
app.js orchestrates which components to initialize
index.js handles routing/authentication logic
Please implement the exact same patterns, naming conventions, and file structure



---

This updated prompt includes:
- ✅ Exact file/folder structure mirroring MasonDash
- ✅ Vite configuration notes
- ✅ Handlebars template patterns with conditionals
- ✅ CSS instead of SCSS
- ✅ All naming conventions and code patterns
- ✅ Component structure (JS + HBS + CSS triplet)
- ✅ Service layer patterns
- ✅ Entry point routing logic
- ✅ Login and dashboard flows
- ✅ Renders component (replacing courses)