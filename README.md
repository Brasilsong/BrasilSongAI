# Backend BrasilSong AI

Node.js + Express. O servidor mantém projetos/jobs em memória no MVP.

### Rotas
- `GET /api/health`
- `POST /api/projects`
- `GET /api/projects/:id`
- `POST /api/generate`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/export`

O provedor MusicAPI usa `/api/v1/sonic/create`, polling em `/api/v1/sonic/task/{task_id}`, `/sonic/download` para áudio e endpoints de stems. Consulte a documentação oficial antes de alterar versões/modelos.
