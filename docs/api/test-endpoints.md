# Quick Endpoint Test

The `/trigger-by-cap` endpoint appears to be returning 404. Let's test both possible locations:

## Option 1: Try this endpoint
```
POST http://127.0.0.1:8080/api/v1/pipeline/trigger-by-cap
```

## Option 2: If Option 1 gives 404, try:
```
POST http://127.0.0.1:8080/api/v1/alerts/trigger-by-cap
```

## Check What Endpoints Actually Exist

To see all registered endpoints, try:
```
GET http://127.0.0.1:8080/actuator/mappings
```

(This might return 404 if actuator isn't enabled)

## Known Working Endpoints

These should definitely work:
- `GET http://127.0.0.1:8080/health` - Health check
- `GET http://127.0.0.1:8080/api/v1/pipeline/status/{capIdentifier}` - Pipeline status
- `POST http://127.0.0.1:8080/api/v1/alerts/cap` - CAP ingestion (doesn't trigger pipeline)

## Current Issue

The `PipelineTriggerController` is compiled into the JAR but Spring Boot isn't finding it at the expected endpoint `/api/v1/pipeline/trigger-by-cap`.

Possible causes:
1. Controller mapping changed between versions
2. There's a conflict with another controller
3. Bean dependency injection is failing silently

Let's check the CAP Controller instead, which might have the functionality we need.
