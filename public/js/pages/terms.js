  // Renders the policy's real status. A draft never shows an effective date:
  // showing a reader a date under that heading is exactly the claim this page
  // must not make.
  api('/config')
    .then((config) => {
      const policy = config.policies && config.policies.terms;
      if (!policy) return;
      document.getElementById('policy-version').textContent = policy.version;
      document.getElementById('policy-status-pill').textContent = policy.status.toUpperCase();
      if (policy.draftRevisedAt) {
        document.getElementById('policy-revised').textContent = new Date(
          policy.draftRevisedAt + 'T00:00:00Z'
        ).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
      }
      document.getElementById('policy-effective').textContent = policy.effectiveDate
        ? new Date(policy.effectiveDate + 'T00:00:00Z').toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        : 'not yet effective';
    })
    .catch(() => {});
