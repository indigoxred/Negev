# ED2K read pacing for staged verification

The staged verifier now uses one cumulative byte pacer for an entire batch. The default is 16 MiB/s; a later controlled deployment can select a lower bounded rate. Each ED2K chunk reports its actual bytes and yields to the event loop, while the same pacer spans all files so small files cannot each reset the budget. The result and exact digest are unchanged.

This limits **average read throughput**, not instantaneous CPU use: the current JavaScript MD4 calculation still processes a 9.7 MB AniDB chunk synchronously. Production needs a separate worker or container CPU quota, plus a measured NAS pilot outside parity and other heavy jobs. No NAS media was read for these tests.
