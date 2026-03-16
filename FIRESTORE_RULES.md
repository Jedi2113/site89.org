Firestore security rules for Site-89 Mail

Quick notes:
- The rules in `firestore.rules` restrict email reads/writes to authenticated users who are either the sender or a recipient.
- Creates require `request.resource.data.sender` to match the authenticated user's email (prevents sender spoofing).

Deploying rules:
1. Install Firebase CLI (if you haven't):
   npm install -g firebase-tools
2. Login and initialize (if needed):
   firebase login
   firebase init firestore
3. Deploy only the rules:
   firebase deploy --only firestore:rules

If you'd like to allow character-based senders (e.g., lastname.firstname@site89.org) rather than the Auth email,
we should add a mapping from `auth.uid` → selected character (or a `users/{uid}/characters` doc) and then validate
in the rules that `request.resource.data.sender` equals that mapped character email. I can add that mapping if you want.