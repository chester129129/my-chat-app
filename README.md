# My Chat App

A bilingual (Korean and Spanish) chat application with features like:

- Real-time messaging
- User authentication
- File and media sharing
- Push notifications
- Virtual currency (Monera) system
- Friend management

## Technologies Used

- Node.js with Express
- Supabase for database and storage
- Google's Generative AI (Gemini) for translations
- Web Push for notifications
- JWT for authentication

## Setup

1. Clone the repository
2. Install dependencies with `npm install`
3. Create a `.env` file with the following variables:
   - SUPABASE_URL
   - SUPABASE_ANON_KEY
   - JWT_SECRET
   - GOOGLE_API_KEY
   - PASSWORD
   - VAPID_PUBLIC_KEY
   - VAPID_PRIVATE_KEY
   - VAPID_SUBJECT
4. Run the server with `npm start`

## Features

- Automatic translation between Korean and Spanish
- File uploads (images, videos, audio)
- Profile customization
- Virtual currency transfer system
- Push notifications for new messages 