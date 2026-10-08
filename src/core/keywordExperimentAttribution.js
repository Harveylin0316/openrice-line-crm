// Internal SQL fragment shared by the experiment report and message link details.
// k = click, a = assignment; callers join the same experiment, variant and recipient.
function attributedClickWindow(daysParameter) {
  return `a.first_success_at IS NOT NULL
    AND k.clicked_at >= a.first_success_at
    AND k.clicked_at < a.first_success_at + (${daysParameter}::int * INTERVAL '1 day')`;
}
module.exports = { attributedClickWindow };
