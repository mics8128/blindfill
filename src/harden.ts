// MUST be imported before anything that imports Playwright.
// Playwright's DEBUG=pw:api logging prints call arguments, which for a fill is the secret itself.
// ES imports are evaluated in order, so this side-effect module runs first.
delete process.env.DEBUG;
delete process.env.PWDEBUG;
export {};
