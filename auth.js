/* GENERATED FILE - do not edit.
   Source: auth.json   Reset the password: python3 set_password.py */
window.__PARAS_AUTH__ = {
  "$comment": "Sign-in for the Command Centre. Passwords are not stored -- only a PBKDF2-HMAC-SHA256 hash of each. Reset the primary one with: python3 set_password.py -- other accounts are added from the app's own Sign up screen (needs the admin key) and are never touched here.",
  "schema": 2,
  "enabled": true,
  "accounts": [
    {
      "login": "admin/ritik",
      "salt": "c7bd559222e1dd9385001db42e7682ef",
      "hash": "9a59ea7a5c26610a01ec81b158d728c4f0ec7d9fe20870c77f87d4f1b2de0eeb",
      "iterations": 250000,
      "createdAt": 1787552488664,
      "name": "Ritik Nagar"
    }
  ],
  "email": "admin/ritik",
  "logins": [
    "admin/ritik"
  ],
  "salt": "c7bd559222e1dd9385001db42e7682ef",
  "iterations": 250000,
  "hash": "9a59ea7a5c26610a01ec81b158d728c4f0ec7d9fe20870c77f87d4f1b2de0eeb",
  "hint": "",
  "admin": "Ritik Nagar",
  "adminEmail": "ritik.nagar@parashealth.com",
  "adminKeySalt": "369ef9bb0037e2d9e893398371633395",
  "adminKeyHash": "44751893c9ad4a0b50f50f4ce166ac8807a60b58f0d2be5f08435566b044d7bd",
  "maxAttempts": 5,
  "lockoutSeconds": 60
};
