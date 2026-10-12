'use strict';
function validateTemplate(body = {}) {
  const fields = {name:80, subject:200, preheader:300, body_text:4000};
  const value = {};
  for (const [key,max] of Object.entries(fields)) {
    if (typeof body[key] !== 'string' && key !== 'preheader') throw Error('請填寫範本名稱、主旨與內文。');
    value[key] = String(body[key] || '').trim();
    if (value[key].length > max || (key !== 'preheader' && !value[key])) throw Error('欄位空白或超過長度限制。');
  }
  if (/[\r\n]/.test(value.subject)) throw Error('主旨不可換行。');
  return value;
}
function registerRevisitMailTemplates(app, {query, requireAdmin, requireOwner}) {
  app.get('/admin/revisit-email/api/templates', requireAdmin, async (_req,res) => {
    res.setHeader('Cache-Control','no-store');
    try {
      const result = await query('SELECT id,name,subject,preheader,body_text,created_at FROM revisit_email_templates ORDER BY id DESC LIMIT 200');
      res.json({ok:true,templates:result.rows});
    } catch (_) { res.status(503).json({ok:false,detail:'範本暫時無法載入，請稍後重試；現有信件沒有變更。'}); }
  });
  app.post('/admin/revisit-email/api/templates', requireOwner, async (req,res) => {
    let value;
    try { value = validateTemplate(req.body); }
    catch (e) { return res.status(400).json({ok:false,detail:e.message}); }
    try {
      // Append-only: saving a new version never overwrites a colleague's template.
      const result = await query(`INSERT INTO revisit_email_templates (name,subject,preheader,body_text,created_by)
        VALUES ($1,$2,$3,$4,$5) RETURNING id,name,subject,preheader,body_text,created_at`,
      [value.name,value.subject,value.preheader,value.body_text,String(req.authUser?.un || '').slice(0,100)]);
      res.status(201).json({ok:true,template:result.rows[0]});
    } catch (_) { res.status(503).json({ok:false,detail:'範本儲存失敗，請稍後重試；請勿關閉尚未儲存的內容。'}); }
  });
}
module.exports = {validateTemplate,registerRevisitMailTemplates};
