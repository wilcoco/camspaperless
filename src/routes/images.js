import { Router } from 'express';
import { getImage } from '../storage.js';

const router = Router();

router.get('/:id', async (req, res) => {
  const img = await getImage(req.params.id);
  if (!img) return res.status(404).send('not found');
  res.set('Content-Type', img.content_type);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(img.data);
});

export default router;
