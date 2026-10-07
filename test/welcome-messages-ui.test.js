const test=require('node:test');const assert=require('node:assert/strict');
test('welcome routes protect settings and return explicit unavailable state when migration missing',async()=>{
 const {registerAdminWelcomeMessagesRoutes}=require('../src/routes/adminWelcomeMessages');
 const routes={};const guard=()=>{};
 registerAdminWelcomeMessagesRoutes({get(p,...h){routes[p]=h},post(p,...h){routes['POST '+p]=h}},{query:async()=>{const e=new Error('missing');e.code='42P01';throw e},pool:{},authCore:{requireAdmin:guard}});
 assert.equal(routes['/admin/welcome-messages/api'][0],guard);
 const res={status(n){this.code=n;return this},json(b){this.body=b}};await routes['/admin/welcome-messages/api'].at(-1)({},res);
 assert.equal(res.code,503);assert.equal(res.body.error,'migration_required');
});
