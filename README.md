# 🚌 HK Bus Fetch

A real-time Hong Kong bus information tool designed for practical, daily commuting. It leverages public open data to provide accurate arrival times, route information, and walking duration estimates.

## ✨ Features

- **Real-time ETA:** Fetches live arrival data directly from the KMB Open Data API.
- **Smart Geocoding:** Integration with OpenStreetMap (Nominatim) to search for locations and bus stops across Hong Kong.
- **Walking Estimates:** Calculates estimated walking time to bus stops based on your current location and walking speed.
- **Autocomplete Suggestions:** Intelligent search for bus routes and locations to speed up your commute planning.
- **GPS Integration:** Quickly find bus stops near your current location with one-click GPS positioning.
- **Responsive Design:** Optimized for both desktop and mobile devices.

## 🚀 Getting Started

### Prerequisites
- A modern web browser with location permissions enabled (optional but recommended for GPS features).

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/tototofu123/hk-bus-fetch.git
   ```
2. Open `index.html` in your browser.

## 🛠️ Technology Stack

- **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3.
- **APIs:** 
  - [KMB Open Data API](https://data.etabus.gov.hk/) (Real-time bus data).
  - [Nominatim OpenStreetMap API](https://nominatim.openstreetmap.org/) (Geocoding).
- **CI/CD:** GitHub Actions for automated metrics and tracking.

## 📂 Project Structure

- `index.html`: Main application interface.
- `script.js`: Core logic for API integration, distance calculations, and UI updates.
- `styles.css`: Modern, responsive layout and styling.
- `.github/workflows/`: Automation for repository metrics.

## 🔧 Core Logic
The application performs complex asynchronous operations:
- **`fetchWithTimeout`:** Ensures API requests don't hang by implementing a custom abort controller.
- **Distance Calculation:** Uses the Haversine formula to calculate the great-circle distance between coordinates.
- **ETA Merging:** Combines route data with stop information and live arrival times for a comprehensive commute overview.
