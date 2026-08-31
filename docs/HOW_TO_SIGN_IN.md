# Signing in to the Paras Health SCM Gen-Dash

This reflects the sign-in screen as it works today, including the
admin-approval flow for new accounts, password resets, and username
changes, and the optional authenticator-app (TOTP) second step. The same
walkthrough is also available from inside the app: click **How to sign in
/ reset your password** underneath the sign-in card.

## Signing in

1. Open the Command Centre address given to you (or double-click
   `start.bat` if you're on the machine that runs it).
2. Under **Username**, type your exact sign-in name and press **Continue**.
3. A **Security password** field appears. Type your password and press
   **Continue** again.
4. If two-factor authentication is turned on for your account, you'll be
   asked for the 6-digit code from your authenticator app -- or one of
   your backup codes if you don't have the app to hand.
5. You're in.

Usernames and passwords are both case-sensitive -- typed exactly as they
were set up, capital letters included.

## If you type the wrong password

You'll see a message telling you how many attempts you have left before a
short lockout. Just wait it out and try again carefully -- there's nothing
to reset or contact anyone about for a simple mistyped password.

## Resetting a forgotten password

1. On the sign-in screen, click **Forgot password?** underneath the
   password field.
2. Enter your exact **Username**.
3. Enter a **New password** (at least 10 characters) and repeat it in the
   field below to confirm.
4. Submit. This sends a request to the admin -- your password does not
   actually change until they approve it. Try signing in with the new
   password once they have.

This request is handled entirely by the admin from the admin panel --
nothing is emailed, since there's no mail server wired in yet.

## Signing up for a new account

Use the **Sign up** link on the sign-in screen, fill in your name,
designation, department, category, phone number, email, Paras ID and a
password (at least 10 characters), and submit. Like a password reset, this
goes to the admin as a request -- you can sign in once it's approved, not
immediately.

## Two-factor authentication

Once signed in, turn it on from the account menu, under **Security**.
Scan the QR code shown with an authenticator app (Google Authenticator,
Authy, 1Password, or similar), or enter the setup key by hand if you'd
rather not scan. Keep the backup codes shown at that point somewhere
safe -- each one signs you in exactly once if you ever lose the
authenticator app, and the admin can turn 2FA off for your account as a
last resort if you lose both.

## Who to ask

If anything here doesn't match what you're seeing, contact your
administrator directly rather than guessing.
