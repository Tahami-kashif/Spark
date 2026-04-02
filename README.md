# CLI-Agent-Terminal-Publish — FastAPI Project

Auto-scaffolded by **Spark CLI**.

## Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run dev server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET    | /         | Root / health check |
| GET    | /docs     | Swagger UI |
| GET    | /redoc    | ReDoc UI |
| GET    | /items    | List all items |
| POST   | /items    | Create item |
| GET    | /items/{id} | Get item |
| PUT    | /items/{id} | Update item |
| DELETE | /items/{id} | Delete item |
| GET    | /users    | List users |
| POST   | /users    | Create user |

## Project Structure

```
CLI-Agent-Terminal-Publish/
├── main.py          # FastAPI app entry
├── database.py      # DB connection & session
├── requirements.txt
├── .env
├── models/
│   ├── item.py
│   └── user.py
├── routes/
│   ├── items.py
│   └── users.py
└── schemas/
```
